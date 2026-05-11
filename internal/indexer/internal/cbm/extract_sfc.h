#ifndef CTX_EXTRACT_SFC_H
#define CTX_EXTRACT_SFC_H

#include "cbm.h"

// Extract definitions, imports, calls, and usages from Vue/Svelte SFCs.
// Re-parses <script> blocks with TS/JS grammar and walks <template> for
// component references and directive attributes.
// Called from ctx_extract_file() when language is CTX_LANG_VUE or CTX_LANG_SVELTE.
void ctx_extract_sfc(CBMExtractCtx *ctx);

#endif // CTX_EXTRACT_SFC_H
