#ifndef CTX_H
#define CTX_H

#include <stdint.h>
#include <stdbool.h>
#include "arena.h"
#include "tree_sitter/api.h"

// Language enum mirrors lang.Language in Go.
// Order must match lang_specs.c tables.
typedef enum {
    CTX_LANG_GO = 0,
    CTX_LANG_PYTHON,
    CTX_LANG_JAVASCRIPT,
    CTX_LANG_TYPESCRIPT,
    CTX_LANG_TSX,
    CTX_LANG_RUST,
    CTX_LANG_JAVA,
    CTX_LANG_CPP,
    CTX_LANG_CSHARP,
    CTX_LANG_PHP,
    CTX_LANG_LUA,
    CTX_LANG_SCALA,
    CTX_LANG_KOTLIN,
    CTX_LANG_RUBY,
    CTX_LANG_C,
    CTX_LANG_BASH,
    CTX_LANG_ZIG,
    CTX_LANG_ELIXIR,
    CTX_LANG_HASKELL,
    CTX_LANG_OCAML,
    CTX_LANG_OBJC,
    CTX_LANG_SWIFT,
    CTX_LANG_DART,
    CTX_LANG_PERL,
    CTX_LANG_GROOVY,
    CTX_LANG_ERLANG,
    CTX_LANG_R,
    CTX_LANG_HTML,
    CTX_LANG_CSS,
    CTX_LANG_SCSS,
    CTX_LANG_YAML,
    CTX_LANG_TOML,
    CTX_LANG_HCL,
    CTX_LANG_SQL,
    CTX_LANG_DOCKERFILE,
    // New languages (v0.5 expansion)
    CTX_LANG_CLOJURE,
    CTX_LANG_FSHARP,
    CTX_LANG_JULIA,
    CTX_LANG_VIMSCRIPT,
    CTX_LANG_NIX,
    CTX_LANG_COMMONLISP,
    CTX_LANG_ELM,
    CTX_LANG_FORTRAN,
    CTX_LANG_CUDA,
    CTX_LANG_COBOL,
    CTX_LANG_VERILOG,
    CTX_LANG_EMACSLISP,
    CTX_LANG_JSON,
    CTX_LANG_XML,
    CTX_LANG_MARKDOWN,
    CTX_LANG_MAKEFILE,
    CTX_LANG_CMAKE,
    CTX_LANG_PROTOBUF,
    CTX_LANG_GRAPHQL,
    CTX_LANG_VUE,
    CTX_LANG_SVELTE,
    CTX_LANG_MESON,
    CTX_LANG_GLSL,
    CTX_LANG_INI,
    // Scientific/math languages
    CTX_LANG_MATLAB,
    CTX_LANG_LEAN,
    CTX_LANG_FORM,
    CTX_LANG_MAGMA,
    CTX_LANG_WOLFRAM,
    CTX_LANG_KUSTOMIZE, // kustomization.yaml — Kubernetes overlay tool
    CTX_LANG_K8S,       // Generic Kubernetes manifest (apiVersion: detected)
    CTX_LANG_COUNT
} CtxLanguage;

// --- Extraction result structs ---

typedef struct {
    const char *name;           // short name
    const char *qualified_name; // project.path.name
    const char *label;          // "Function", "Method", "Class", "Variable", "Module"
    const char *file_path;      // relative path
    uint32_t start_line;
    uint32_t end_line;
    const char *signature;     // parameter text (NULL if none)
    const char *return_type;   // return type text (NULL if none)
    const char *receiver;      // Go method receiver (NULL if none)
    const char *docstring;     // leading doc comment (NULL if none)
    const char *parent_class;  // enclosing class QN for methods (NULL if none)
    const char **decorators;   // NULL-terminated array (NULL if none)
    const char **base_classes; // NULL-terminated array (NULL if none)
    const char **param_names;  // NULL-terminated array (NULL if none)
    const char **param_types;  // NULL-terminated array (NULL if none)
    const char **return_types; // NULL-terminated array (NULL if none)
    const char *route_path;    // HTTP route path from decorator (e.g., "/api/users") or NULL
    const char *route_method;  // HTTP method from decorator (e.g., "POST") or NULL
    int complexity;            // cyclomatic complexity
    int lines;                 // body line count
    uint32_t *fingerprint;     // MinHash fingerprint (arena-allocated, K values) or NULL
    int fingerprint_k;         // number of hash values (CTX_MINHASH_K or 0)
    bool is_exported;
    bool is_abstract;
    bool is_test;
    bool is_entry_point;
    const char *structural_profile; // AST structural profile (arena-allocated) or NULL
    const char *body_tokens; // space-separated raw identifier tokens from body (arena) or NULL
} CtxDefinition;

/* Argument captured from a call expression */
typedef struct {
    const char *expr;    // raw expression text ("payload.info", "MY_URL", "'hello'")
    const char *value;   // resolved string value or NULL (constant propagation)
    const char *keyword; // keyword name if keyword arg ("url", "topic_id"), NULL if positional
    int index;           // positional index (0-based)
} CtxCallArg;

#define CTX_MAX_CALL_ARGS 8

typedef struct {
    const char *callee_name;            // raw callee text ("pkg.Func", "foo")
    const char *enclosing_func_qn;      // QN of enclosing function (or module QN)
    const char *first_string_arg;       // first string literal argument (URL, topic, key) or NULL
    const char *second_arg_name;        // second argument identifier (handler ref) or NULL
    CtxCallArg args[CTX_MAX_CALL_ARGS]; // first N arguments with expressions
    int arg_count;                      // number of captured arguments
} CtxCall;

typedef struct {
    const char *local_name;  // local alias or name
    const char *module_path; // resolved module path / QN
} CtxImport;

typedef struct {
    const char *ref_name;          // referenced identifier
    const char *enclosing_func_qn; // QN of enclosing function (or module QN)
} CtxUsage;

typedef struct {
    const char *exception_name;    // exception class/type name
    const char *enclosing_func_qn; // QN of enclosing function
} CtxThrow;

typedef struct {
    const char *var_name;          // variable name
    const char *enclosing_func_qn; // QN of enclosing function
    bool is_write;                 // true = write, false = read
} CtxReadWrite;

typedef struct {
    const char *type_name;         // referenced type/class name
    const char *enclosing_func_qn; // QN of enclosing function
} CtxTypeRef;

typedef struct {
    const char *env_key;           // environment variable key
    const char *enclosing_func_qn; // QN of enclosing function
} CtxEnvAccess;

typedef struct {
    const char *var_name;          // variable being assigned
    const char *type_name;         // class/type name of RHS constructor
    const char *enclosing_func_qn; // QN of enclosing function
} CtxTypeAssign;

// String reference: URL, config key, or async target found in source.
// Extracted from string literals during AST walk.
typedef enum {
    CTX_STRREF_URL = 0,    // REST path or full URL
    CTX_STRREF_CONFIG = 1, // config file path or env var key
} CtxStringRefKind;

typedef struct {
    const char *value;             // the string literal content
    const char *enclosing_func_qn; // QN of enclosing function
    const char *key_path;          // dotted key path from YAML/JSON nesting (NULL if flat)
    CtxStringRefKind kind;         // URL, CONFIG
} CtxStringRef;

/* Infrastructure binding: topic/queue → endpoint URL.
 * Extracted from YAML/HCL/JSON subscription/scheduler configs.
 * Used by pass_route_nodes to connect async Route nodes to handler services. */
typedef struct {
    const char *source_name; // topic, queue, or schedule name
    const char *target_url;  // push_endpoint, uri, or http_target URL
    const char *broker;      // "pubsub", "cloud_tasks", "cloud_scheduler", "sqs", "kafka"
} CtxInfraBinding;

/* Pub/sub channel participation.  One record per emit() or on()/addListener()
 * call detected in source — the receiver (e.g. Socket.IO client, EventEmitter
 * instance) is intentionally NOT identified; matching is by channel_name
 * across files, which captures the common pattern of one logical bus per
 * service.  Transport disambiguates Socket.IO vs EventEmitter vs future
 * detectors (Kafka, Cloud Pub/Sub, etc.). */
typedef enum {
    CTX_CHANNEL_EMIT = 0,
    CTX_CHANNEL_LISTEN = 1,
} CtxChannelDirection;

typedef struct {
    const char *channel_name;      // literal channel name (e.g. "user.created")
    const char *transport;         // "socketio", "event_emitter", ...
    const char *enclosing_func_qn; // QN of the function containing the emit/on call
    CtxChannelDirection direction;
} CtxChannel;

// Rust: impl Trait for Struct
typedef struct {
    const char *trait_name;  // trait name (raw text)
    const char *struct_name; // struct/type name (raw text)
} CtxImplTrait;

// LSP-resolved call: high-confidence type-aware call resolution
typedef struct {
    const char *caller_qn; // enclosing function QN
    const char *callee_qn; // resolved target QN (fully qualified)
    const char *strategy;  // "lsp_type_dispatch", "lsp_direct", etc.
    float confidence;      // 0.90-0.95
    const char *reason;    // diagnostic label for unresolved calls (NULL if resolved)
} CtxResolvedCall;

typedef struct {
    CtxResolvedCall *items;
    int count;
    int cap;
} CtxResolvedCallArray;

// Growable arrays used during extraction.
typedef struct {
    CtxDefinition *items;
    int count;
    int cap;
} CtxDefArray;

typedef struct {
    CtxCall *items;
    int count;
    int cap;
} CtxCallArray;

typedef struct {
    CtxImport *items;
    int count;
    int cap;
} CtxImportArray;

typedef struct {
    CtxUsage *items;
    int count;
    int cap;
} CtxUsageArray;

typedef struct {
    CtxThrow *items;
    int count;
    int cap;
} CtxThrowArray;

typedef struct {
    CtxReadWrite *items;
    int count;
    int cap;
} CtxRWArray;

typedef struct {
    CtxTypeRef *items;
    int count;
    int cap;
} CtxTypeRefArray;

typedef struct {
    CtxEnvAccess *items;
    int count;
    int cap;
} CtxEnvAccessArray;

typedef struct {
    CtxTypeAssign *items;
    int count;
    int cap;
} CtxTypeAssignArray;

typedef struct {
    CtxStringRef *items;
    int count;
    int cap;
} CtxStringRefArray;

typedef struct {
    CtxInfraBinding *items;
    int count;
    int cap;
} CtxInfraBindingArray;

typedef struct {
    CtxImplTrait *items;
    int count;
    int cap;
} CtxImplTraitArray;

typedef struct {
    CtxChannel *items;
    int count;
    int cap;
} CtxChannelArray;

// Full extraction result for one file.
typedef struct {
    CtxArena arena; // owns all string memory

    CtxDefArray defs;
    CtxCallArray calls;
    CtxImportArray imports;
    CtxUsageArray usages;
    CtxThrowArray throws;
    CtxRWArray rw;
    CtxTypeRefArray type_refs;
    CtxEnvAccessArray env_accesses;
    CtxTypeAssignArray type_assigns;
    CtxImplTraitArray impl_traits;       // Rust: impl Trait for Struct pairs
    CtxResolvedCallArray resolved_calls; // LSP-resolved calls (high confidence)
    CtxStringRefArray string_refs;       // URL/config string literals from AST
    CtxInfraBindingArray infra_bindings; // topic→URL pairs from IaC configs
    CtxChannelArray channels;            // Socket.IO / EventEmitter pub/sub participation

    const char *module_qn;    // module qualified name
    const char **exports;     // NULL-terminated (NULL if none)
    const char **constants;   // NULL-terminated (NULL if none)
    const char **global_vars; // NULL-terminated (NULL if none)
    const char **macros;      // NULL-terminated, C/C++ only (NULL if none)

    bool has_error;
    const char *error_msg;
    bool is_test_file;
    int imports_count;
    TSTree *cached_tree;     // retained parse tree (caller frees via ctx_free_tree)
    CtxLanguage cached_lang; // language of cached tree (for parser selection)
} CtxFileResult;

// --- Enclosing function cache ---
// Avoids repeated parent-chain walks for nodes within the same function body.
// Each entry records a function's byte range and its precomputed QN.
#define EFC_SIZE 64 // power of 2 for fast modulo

typedef struct {
    uint32_t start_byte;
    uint32_t end_byte;
    const char *qn;
} EFCEntry;

typedef struct {
    EFCEntry entries[EFC_SIZE];
    int count;
} EFCache;

// --- Extraction context passed to sub-extractors ---

// Module-level string constant map (for constant propagation)
#define CTX_MAX_STRING_CONSTANTS 256
typedef struct {
    const char *names[CTX_MAX_STRING_CONSTANTS];
    const char *values[CTX_MAX_STRING_CONSTANTS];
    int count;
} CtxStringConstantMap;

typedef struct {
    CtxArena *arena;
    CtxFileResult *result;
    const char *source;
    int source_len;
    CtxLanguage language;
    const char *project;
    const char *rel_path;
    const char *module_qn;
    TSNode root;
    EFCache ef_cache;                      // enclosing function cache
    const char *enclosing_class_qn;        // for nested class QN computation
    CtxStringConstantMap string_constants; // module-level NAME = "value" pairs
} CtxExtractCtx;

// --- Public API ---

// Initialize the library. Call once at startup. Returns 0 on success.
int ctx_init(void);

// Extract all data from one file. Caller must call ctx_free_result().
// source must remain valid for the duration of the call.
// timeout_micros: per-file parse timeout in microseconds (0 = no timeout).
CtxFileResult *ctx_extract_file(const char *source, int source_len, CtxLanguage language,
                                const char *project, const char *rel_path, int64_t timeout_micros,
                                const char **extra_defines, // NULL-terminated, or NULL
                                const char **include_paths  // NULL-terminated, or NULL
);

// Free all memory associated with a result.
void ctx_free_result(CtxFileResult *result);

// Free only the cached tree from a result (caller retained it for reuse).
void ctx_free_tree(CtxFileResult *result);

// Free a standalone TSTree pointer (for Go layer cleanup).
void ctx_free_tree_ptr(TSTree *tree);

// Parse a source string with the given language grammar.
// Returns a TSTree* (caller must ts_tree_delete). Returns NULL on failure.
// Uses the thread-local parser pool for efficiency.
TSTree *ctx_parse_string(const char *source, int source_len, CtxLanguage language);

// Reset the thread-local parser's internal state, releasing slab-allocated
// subtrees. Must be called BEFORE ctx_slab_reset_thread() so the slab rebuild
// doesn't corrupt live parser state.
void ctx_reset_thread_parser(void);

// Destroy the thread-local parser. Call on worker thread exit.
void ctx_destroy_thread_parser(void);

// Shutdown the library. Call once at exit.
void ctx_shutdown(void);

// Profiling: get accumulated parse/extraction times and file count.
typedef struct {
    uint64_t *parse_ns;
    uint64_t *extract_ns;
    uint64_t *files;
} ctx_profile_out_t;
void ctx_get_profile(ctx_profile_out_t out);
uint64_t ctx_get_lsp_ns(void);
uint64_t ctx_get_preprocess_ns(void);
uint64_t ctx_get_files_preprocessed(void);
void ctx_reset_profile(void);

// --- Internal helpers used by extractors ---

// Growable array push functions (arena-allocated, no individual free needed).
void ctx_defs_push(CtxDefArray *arr, CtxArena *a, CtxDefinition def);
void ctx_calls_push(CtxCallArray *arr, CtxArena *a, CtxCall call);
void ctx_imports_push(CtxImportArray *arr, CtxArena *a, CtxImport imp);
void ctx_usages_push(CtxUsageArray *arr, CtxArena *a, CtxUsage usage);
void ctx_throws_push(CtxThrowArray *arr, CtxArena *a, CtxThrow thr);
void ctx_rw_push(CtxRWArray *arr, CtxArena *a, CtxReadWrite rw);
void ctx_typerefs_push(CtxTypeRefArray *arr, CtxArena *a, CtxTypeRef tr);
void ctx_envaccess_push(CtxEnvAccessArray *arr, CtxArena *a, CtxEnvAccess ea);
void ctx_typeassign_push(CtxTypeAssignArray *arr, CtxArena *a, CtxTypeAssign ta);
void ctx_stringref_push(CtxStringRefArray *arr, CtxArena *a, CtxStringRef sr);
void ctx_infrabinding_push(CtxInfraBindingArray *arr, CtxArena *a, CtxInfraBinding ib);
void ctx_impltrait_push(CtxImplTraitArray *arr, CtxArena *a, CtxImplTrait it);
void ctx_resolvedcall_push(CtxResolvedCallArray *arr, CtxArena *a, CtxResolvedCall rc);
void ctx_channels_push(CtxChannelArray *arr, CtxArena *a, CtxChannel ch);

// --- Sub-extractor entry points ---

void ctx_extract_definitions(CtxExtractCtx *ctx);
void ctx_extract_calls(CtxExtractCtx *ctx);
void ctx_extract_imports(CtxExtractCtx *ctx);
void ctx_extract_usages(CtxExtractCtx *ctx);
void ctx_extract_semantic(CtxExtractCtx *ctx);
void ctx_extract_type_refs(CtxExtractCtx *ctx);
void ctx_extract_env_accesses(CtxExtractCtx *ctx);
void ctx_extract_type_assigns(CtxExtractCtx *ctx);
void ctx_extract_channels(CtxExtractCtx *ctx);

// Single-pass unified extraction (replaces the 7 calls above except defs+imports).
void ctx_extract_unified(CtxExtractCtx *ctx);

// K8s / Kustomize semantic extractor (called when language is CTX_LANG_K8S or CTX_LANG_KUSTOMIZE).
void ctx_extract_k8s(CtxExtractCtx *ctx);

#endif // CTX_H
