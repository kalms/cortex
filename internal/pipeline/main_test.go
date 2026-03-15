package pipeline

import (
	"testing"

	"go.uber.org/goleak"
)

func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m,
		// HTTP transport dial goroutines from version checker
		goleak.IgnoreTopFunction("net/http.(*Transport).dialConnFor"),
		goleak.IgnoreTopFunction("internal/poll.runtime_pollWait"),
		// SQLite connection opener from store.OpenPath in full-index tests
		goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"),
	)
}
