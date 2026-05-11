/*
 * progress_sink.h — Human-readable progress output for --progress CLI flag.
 *
 * Installs a log sink that maps structured pipeline events to phase labels.
 * Usage:
 *   ctx_progress_sink_init(stderr);
 *   // ... run pipeline ...
 *   ctx_progress_sink_fini();
 */
#ifndef CTX_PROGRESS_SINK_H
#define CTX_PROGRESS_SINK_H

#include <stdio.h>

void ctx_progress_sink_init(FILE *out);
void ctx_progress_sink_fini(void);
void ctx_progress_sink_fn(const char *line);

#endif
