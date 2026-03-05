package pipeline

import (
	"context"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// contentionSignal holds platform-specific contention metrics.
// Populated by getContentionSignal() in adaptive_csw_{unix,windows}.go.
type contentionSignal struct {
	Nivcsw     int64   // involuntary context switches (0 if unavailable)
	CPUTimeSec float64 // cumulative process CPU time in seconds (0 if unavailable)
}

// contentionTier describes which contention signal is available.
type contentionTier int

const (
	tierNone contentionTier = iota // tier 3: grow-only with cap
	tierCPU                        // tier 2: CPU utilization
	tierCSW                        // tier 1: involuntary context switches (best)
)

func (t contentionTier) String() string {
	switch t {
	case tierCSW:
		return "1-nivcsw"
	case tierCPU:
		return "2-cpu"
	default:
		return "3-none"
	}
}

// adaptivePool manages worker concurrency using bytes/sec throughput for grow
// decisions and tiered contention signals for shrink decisions.
//
// Bytes/sec normalizes for file size variation (50KB vs 500B files produce a
// 5x ratio, not 1000x like files/sec). Shrink only fires when contention is
// detected (Nivcsw or CPU utilization), preventing the death spiral caused by
// large-file batches that reduce files/sec without actual over-provisioning.
type adaptivePool struct {
	mu       sync.Mutex
	cond     *sync.Cond
	limit    int // current concurrency limit
	active   int // currently running workers
	minLimit int // floor (NumCPU)
	maxLimit int // ceiling (NumCPU * 8)
	growStep int // additive increase per adjustment
	numCPU   int

	completed      atomic.Int64
	bytesProcessed atomic.Int64
	peakBPS        float64
	peakLimit      int
	startTime      time.Time
	done           chan struct{}
}

func newAdaptivePool(numCPU int) *adaptivePool {
	if numCPU < 1 {
		numCPU = 1
	}
	step := numCPU / 2
	if step < 2 {
		step = 2
	}
	p := &adaptivePool{
		limit:     numCPU,
		minLimit:  numCPU,
		maxLimit:  numCPU * 8,
		growStep:  step,
		numCPU:    numCPU,
		startTime: time.Now(),
		done:      make(chan struct{}),
	}
	p.cond = sync.NewCond(&p.mu)
	return p
}

func (p *adaptivePool) acquire() {
	p.mu.Lock()
	for p.active >= p.limit {
		p.cond.Wait()
	}
	p.active++
	p.mu.Unlock()
}

// releaseBytes records a completed file with its size and unblocks a waiting worker.
func (p *adaptivePool) releaseBytes(size int64) {
	p.completed.Add(1)
	p.bytesProcessed.Add(size)
	p.mu.Lock()
	p.active--
	p.mu.Unlock()
	p.cond.Signal()
}

func (p *adaptivePool) setLimit(n int) {
	if n < p.minLimit {
		n = p.minLimit
	}
	if n > p.maxLimit {
		n = p.maxLimit
	}
	p.mu.Lock()
	old := p.limit
	p.limit = n
	p.mu.Unlock()
	if n > old {
		p.cond.Broadcast()
	}
}

func (p *adaptivePool) currentLimit() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.limit
}

// monitorTuning groups all tuning constants for the adaptive monitor.
const (
	monitorWarmupTicks = 3
	monitorCooldownLen = 2
	monitorEMAAlpha    = 0.3
	monitorGrowThresh  = 1.05 // bytes/sec must exceed baseline by 5% to grow
	monitorShrinkBPS   = 0.95 // bytes/sec must drop below baseline by 5% to shrink
	monitorCPUCeil     = 0.90 // CPU utilization threshold for tier 2 shrink
)

// monitorState holds mutable per-tick state for the adaptive monitor.
type monitorState struct {
	tick       int
	tier       contentionTier
	cooldown   int
	lastBytes  int64
	lastNivcsw int64
	lastCPU    float64
	emaBPS     float64
	emaNivcsw  float64
	emaCPUUtil float64
	baseBPS    float64
	baseNivcsw float64
	numCPU     float64
}

// monitor runs the adaptive concurrency control loop.
// Tick interval: 1 second. Warmup: 3 ticks. Cooldown: 2 ticks after each adjustment.
func (p *adaptivePool) monitor(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	ms := &monitorState{numCPU: float64(runtime.NumCPU())}
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.done:
			return
		case <-ticker.C:
			p.onTick(ms)
		}
	}
}

// onTick processes one sampling interval: updates metrics, then grows or shrinks.
func (p *adaptivePool) onTick(ms *monitorState) {
	ms.tick++

	// Sample and smooth metrics.
	bytesNow := p.bytesProcessed.Load()
	bps := float64(bytesNow - ms.lastBytes)
	ms.lastBytes = bytesNow
	sig := getContentionSignal()
	nivcsw := sig.Nivcsw - ms.lastNivcsw
	cpuUtil := (sig.CPUTimeSec - ms.lastCPU) / ms.numCPU
	ms.lastNivcsw = sig.Nivcsw
	ms.lastCPU = sig.CPUTimeSec
	p.updateEMA(ms, bps, float64(nivcsw), cpuUtil)

	// Track peaks.
	if ms.emaBPS > p.peakBPS {
		p.peakBPS = ms.emaBPS
	}
	cur := p.currentLimit()
	if cur > p.peakLimit {
		p.peakLimit = cur
	}

	// Warmup phase: detect tier, grow-only.
	if ms.tick <= monitorWarmupTicks {
		p.handleWarmupTick(ms, sig, cur)
		return
	}

	// Calibrate tier on first post-warmup tick.
	if ms.tick == monitorWarmupTicks+1 {
		slog.Info("adaptive.calibrate", "tier", ms.tier.String(),
			"nivcsw_total", sig.Nivcsw, "cpu_sec", sig.CPUTimeSec)
		ms.baseBPS = ms.emaBPS
		ms.baseNivcsw = ms.emaNivcsw
	}

	// Cooldown after adjustment.
	if ms.cooldown > 0 {
		ms.cooldown--
		if ms.cooldown == 0 {
			ms.baseBPS = ms.emaBPS
			ms.baseNivcsw = ms.emaNivcsw
		}
		return
	}

	// GROW: bytes/sec improving.
	if ms.emaBPS > ms.baseBPS*monitorGrowThresh && cur < p.maxLimit {
		p.setLimit(cur + p.growStep)
		ms.cooldown = monitorCooldownLen
		slog.Info("adaptive.grow", "from", cur, "to", p.currentLimit(),
			"bps_mb", ms.emaBPS/(1024*1024))
		return
	}

	// SHRINK: requires contention + throughput decline.
	if p.hasContention(ms) && ms.emaBPS < ms.baseBPS*monitorShrinkBPS && cur > p.minLimit {
		p.setLimit(cur - p.growStep)
		ms.cooldown = monitorCooldownLen
		slog.Info("adaptive.shrink", "from", cur, "to", p.currentLimit(),
			"bps_mb", ms.emaBPS/(1024*1024),
			"nivcsw_ema", int(ms.emaNivcsw), "cpu_util", ms.emaCPUUtil)
	}
}

// updateEMA applies exponential moving average smoothing to all three metrics.
func (p *adaptivePool) updateEMA(ms *monitorState, bps, nivcsw, cpuUtil float64) {
	const alpha = monitorEMAAlpha
	if ms.tick == 1 {
		ms.emaBPS = bps
		ms.emaNivcsw = nivcsw
		ms.emaCPUUtil = cpuUtil
	} else {
		ms.emaBPS = alpha*bps + (1-alpha)*ms.emaBPS
		ms.emaNivcsw = alpha*nivcsw + (1-alpha)*ms.emaNivcsw
		ms.emaCPUUtil = alpha*cpuUtil + (1-alpha)*ms.emaCPUUtil
	}
}

// handleWarmupTick handles one tick during the warmup phase: detects tier and grows only.
func (p *adaptivePool) handleWarmupTick(ms *monitorState, sig contentionSignal, cur int) {
	if sig.Nivcsw > 0 {
		ms.tier = tierCSW
	} else if sig.CPUTimeSec > 0 && ms.tier < tierCPU {
		ms.tier = tierCPU
	}
	if ms.tick > 1 && ms.emaBPS > ms.baseBPS*monitorGrowThresh && cur < p.maxLimit {
		p.setLimit(cur + p.growStep)
		slog.Info("adaptive.grow", "from", cur, "to", p.currentLimit(),
			"bps_mb", ms.emaBPS/(1024*1024), "phase", "warmup")
	}
	ms.baseBPS = ms.emaBPS
	ms.baseNivcsw = ms.emaNivcsw
}

// hasContention returns true if the current tier's contention signal is active.
func (p *adaptivePool) hasContention(ms *monitorState) bool {
	nivcswFloor := ms.numCPU * 100
	switch ms.tier {
	case tierCSW:
		threshold := ms.baseNivcsw * 2
		if threshold < nivcswFloor {
			threshold = nivcswFloor
		}
		return ms.emaNivcsw > threshold
	case tierCPU:
		return ms.emaCPUUtil > monitorCPUCeil
	default:
		return false // tierNone: grow-only mode
	}
}

func (p *adaptivePool) stop() {
	close(p.done)
	totalBytes := p.bytesProcessed.Load()
	slog.Info("adaptive.summary",
		"start", p.minLimit,
		"peak", p.peakLimit,
		"final", p.currentLimit(),
		"peak_bps_mb", p.peakBPS/(1024*1024),
		"total_mb", float64(totalBytes)/(1024*1024),
		"completed", p.completed.Load(),
		"elapsed", time.Since(p.startTime),
	)
}
