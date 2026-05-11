#ifndef CBM_EXTRACT_SFC_H
#define CBM_EXTRACT_SFC_H

#include "cbm.h"

// Extract definitions, imports, calls, and usages from Vue/Svelte SFCs.
// Re-parses <script> blocks with TS/JS grammar and walks <template> for
// component references and directive attributes.
// Called from cbm_extract_file() when language is CBM_LANG_VUE or CBM_LANG_SVELTE.
void cbm_extract_sfc(CBMExtractCtx *ctx);

#endif // CBM_EXTRACT_SFC_H
