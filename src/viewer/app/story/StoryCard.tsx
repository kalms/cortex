import { useUiStore } from "../ui-store";
import { SpotlightChips } from "../SpotlightChips";
import { closeStory, pageStory, syncToAgent } from "./story-controller";

/** `created just now / Nm / Nh / Nd / Nw ago` — staleness signal for the
 *  story card's header (spec §5). */
function relativeAge(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "created just now";
  if (minutes < 60) return `created ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `created ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `created ${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `created ${weeks}w ago`;
}

export function StoryCard() {
  const playback = useUiStore((s) => s.story);
  const spotlight = useUiStore((s) => s.spotlight);
  if (!playback) return null;
  const { story, step, agentStep, following } = playback;
  const cur = story.steps[step - 1];
  return (
    <div className="story-card" id="story-card">
      <div className="story-card-head">
        <span className="story-card-title">{story.title}</span>
        <span className="story-card-age">{relativeAge(story.createdAt)}</span>
      </div>
      <div className="story-card-caption">{cur?.caption ?? ""}</div>
      {spotlight && <SpotlightChips resolved={spotlight.resolved} />}
      {spotlight && spotlight.unresolved.length > 0 &&
        <div className="spotlight-card-unresolved">not in graph: {spotlight.unresolved.join(", ")}</div>}
      <div className="story-card-nav">
        <button aria-label="Previous step" disabled={step <= 1} onClick={() => pageStory(-1)}>‹</button>
        <span className="story-card-pos">{step}/{story.stepCount}</span>
        <button aria-label="Next step" disabled={step >= story.stepCount} onClick={() => pageStory(1)}>›</button>
        {agentStep !== null && !following && agentStep !== step &&
          <button className="story-card-agent-chip" onClick={() => syncToAgent()}>agent is on step {agentStep} →</button>}
      </div>
      <button className="story-card-esc" aria-label="Close story (Esc)" onClick={() => closeStory()}>esc</button>
    </div>
  );
}
