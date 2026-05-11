/*
 * language.c — Language detection from filename and extension.
 *
 * Maps file extensions and special filenames to CtxLanguage enum values.
 * Handles .m disambiguation (Objective-C vs Magma vs MATLAB).
 * Consults the process-global user config (set via ctx_set_user_lang_config)
 * before the built-in lookup table.
 */
#include "discover/discover.h"
#include "discover/userconfig.h"
#include "extract.h" // CtxLanguage, CTX_LANG_*

#include "foundation/constants.h"

enum { LANG_SCAN_PASSES = 2 };
#define SLEN(s) (sizeof(s) - 1)
#include <ctype.h>
#include <stdio.h>
#include <string.h>

/* ── Extension → Language lookup table ───────────────────────────── */

typedef struct {
    const char *ext; /* including dot, e.g. ".go" */
    CtxLanguage language;
} ext_entry_t;

/* Sorted by extension for binary search (but linear scan is fine for ~120 entries) */
static const ext_entry_t EXT_TABLE[] = {
    /* Bash */
    {".bash", CTX_LANG_BASH},
    {".sh", CTX_LANG_BASH},

    /* C */
    {".c", CTX_LANG_C},

    /* C++ */
    {".cc", CTX_LANG_CPP},
    {".ccm", CTX_LANG_CPP},
    {".cpp", CTX_LANG_CPP},
    {".cppm", CTX_LANG_CPP},
    {".cxx", CTX_LANG_CPP},
    {".h", CTX_LANG_CPP},
    {".hh", CTX_LANG_CPP},
    {".hpp", CTX_LANG_CPP},
    {".hxx", CTX_LANG_CPP},
    {".ixx", CTX_LANG_CPP},

    /* C# */
    {".cs", CTX_LANG_CSHARP},

    /* Clojure */
    {".clj", CTX_LANG_CLOJURE},
    {".cljc", CTX_LANG_CLOJURE},
    {".cljs", CTX_LANG_CLOJURE},

    /* CMake */
    {".cmake", CTX_LANG_CMAKE},

    /* COBOL */
    {".cbl", CTX_LANG_COBOL},
    {".cob", CTX_LANG_COBOL},

    /* Common Lisp */
    {".cl", CTX_LANG_COMMONLISP},
    {".lisp", CTX_LANG_COMMONLISP},
    {".lsp", CTX_LANG_COMMONLISP},

    /* CSS */
    {".css", CTX_LANG_CSS},

    /* CUDA */
    {".cu", CTX_LANG_CUDA},
    {".cuh", CTX_LANG_CUDA},

    /* Dart */
    {".dart", CTX_LANG_DART},

    /* Dockerfile */
    {".dockerfile", CTX_LANG_DOCKERFILE},

    /* Elixir */
    {".ex", CTX_LANG_ELIXIR},
    {".exs", CTX_LANG_ELIXIR},

    /* Elm */
    {".elm", CTX_LANG_ELM},

    /* Emacs Lisp */
    {".el", CTX_LANG_EMACSLISP},

    /* Erlang */
    {".erl", CTX_LANG_ERLANG},

    /* F# */
    {".fs", CTX_LANG_FSHARP},
    {".fsi", CTX_LANG_FSHARP},
    {".fsx", CTX_LANG_FSHARP},

    /* FORM */
    {".frm", CTX_LANG_FORM},
    {".prc", CTX_LANG_FORM},

    /* Fortran */
    {".f03", CTX_LANG_FORTRAN},
    {".f08", CTX_LANG_FORTRAN},
    {".f90", CTX_LANG_FORTRAN},
    {".f95", CTX_LANG_FORTRAN},

    /* GLSL */
    {".frag", CTX_LANG_GLSL},
    {".glsl", CTX_LANG_GLSL},
    {".vert", CTX_LANG_GLSL},

    /* Go */
    {".go", CTX_LANG_GO},

    /* GraphQL */
    {".gql", CTX_LANG_GRAPHQL},
    {".graphql", CTX_LANG_GRAPHQL},

    /* Groovy */
    {".gradle", CTX_LANG_GROOVY},
    {".groovy", CTX_LANG_GROOVY},

    /* Haskell */
    {".hs", CTX_LANG_HASKELL},

    /* HCL / Terraform */
    {".hcl", CTX_LANG_HCL},
    {".tf", CTX_LANG_HCL},

    /* HTML */
    {".htm", CTX_LANG_HTML},
    {".html", CTX_LANG_HTML},

    /* INI */
    {".cfg", CTX_LANG_INI},
    {".conf", CTX_LANG_INI},
    {".ini", CTX_LANG_INI},

    /* Java */
    {".java", CTX_LANG_JAVA},

    /* JavaScript */
    {".js", CTX_LANG_JAVASCRIPT},
    {".jsx", CTX_LANG_JAVASCRIPT},

    /* JSON */
    {".json", CTX_LANG_JSON},

    /* Julia */
    {".jl", CTX_LANG_JULIA},

    /* Kotlin */
    {".kt", CTX_LANG_KOTLIN},
    {".kts", CTX_LANG_KOTLIN},

    /* Lean */
    {".lean", CTX_LANG_LEAN},

    /* Lua */
    {".lua", CTX_LANG_LUA},

    /* Magma */
    {".mag", CTX_LANG_MAGMA},
    {".magma", CTX_LANG_MAGMA},

    /* Makefile */
    {".mk", CTX_LANG_MAKEFILE},

    /* Markdown */
    {".md", CTX_LANG_MARKDOWN},
    {".mdx", CTX_LANG_MARKDOWN},

    /* MATLAB */
    {".matlab", CTX_LANG_MATLAB},
    {".mlx", CTX_LANG_MATLAB},

    /* Meson */
    {".meson", CTX_LANG_MESON},

    /* Nix */
    {".nix", CTX_LANG_NIX},

    /* OCaml */
    {".ml", CTX_LANG_OCAML},
    {".mli", CTX_LANG_OCAML},

    /* Perl */
    {".pl", CTX_LANG_PERL},
    {".pm", CTX_LANG_PERL},

    /* PHP */
    {".php", CTX_LANG_PHP},

    /* Protobuf */
    {".proto", CTX_LANG_PROTOBUF},

    /* Python */
    {".py", CTX_LANG_PYTHON},

    /* R — case insensitive handled separately */
    {".R", CTX_LANG_R},
    {".r", CTX_LANG_R},

    /* Ruby */
    {".gemspec", CTX_LANG_RUBY},
    {".rake", CTX_LANG_RUBY},
    {".rb", CTX_LANG_RUBY},

    /* Rust */
    {".rs", CTX_LANG_RUST},

    /* Scala */
    {".sc", CTX_LANG_SCALA},
    {".scala", CTX_LANG_SCALA},

    /* SCSS */
    {".scss", CTX_LANG_SCSS},

    /* SQL */
    {".sql", CTX_LANG_SQL},

    /* Svelte */
    {".svelte", CTX_LANG_SVELTE},

    /* Swift */
    {".swift", CTX_LANG_SWIFT},

    /* SystemVerilog + Verilog */
    {".sv", CTX_LANG_VERILOG},
    {".v", CTX_LANG_VERILOG},

    /* TOML */
    {".toml", CTX_LANG_TOML},

    /* TSX */
    {".tsx", CTX_LANG_TSX},

    /* TypeScript */
    {".ts", CTX_LANG_TYPESCRIPT},

    /* VimScript */
    {".vim", CTX_LANG_VIMSCRIPT},
    {".vimrc", CTX_LANG_VIMSCRIPT},

    /* Vue */
    {".vue", CTX_LANG_VUE},

    /* Wolfram */
    {".wl", CTX_LANG_WOLFRAM},
    {".wls", CTX_LANG_WOLFRAM},

    /* XML */
    {".xml", CTX_LANG_XML},
    {".xsd", CTX_LANG_XML},
    {".xsl", CTX_LANG_XML},
    {".svg", CTX_LANG_XML},

    /* YAML */
    {".yaml", CTX_LANG_YAML},
    {".yml", CTX_LANG_YAML},

    /* Zig */
    {".zig", CTX_LANG_ZIG},
};

#define EXT_TABLE_SIZE (sizeof(EXT_TABLE) / sizeof(EXT_TABLE[0]))

/* ── Special filename → Language lookup ──────────────────────────── */

typedef struct {
    const char *filename;
    CtxLanguage language;
} filename_entry_t;

static const filename_entry_t FILENAME_TABLE[] = {
    {"CMakeLists.txt", CTX_LANG_CMAKE},
    {"Dockerfile", CTX_LANG_DOCKERFILE},
    {"GNUmakefile", CTX_LANG_MAKEFILE},
    {"Makefile", CTX_LANG_MAKEFILE},
    {"makefile", CTX_LANG_MAKEFILE},
    {"meson.build", CTX_LANG_MESON},
    {"meson.options", CTX_LANG_MESON},
    {"meson_options.txt", CTX_LANG_MESON},
    {"kustomization.yaml", CTX_LANG_KUSTOMIZE},
    {"kustomization.yml", CTX_LANG_KUSTOMIZE},
    /* Note: FILENAME_TABLE uses case-sensitive strcmp, so mixed-case variants
     * (e.g. "Kustomization.yaml") are not matched here.  They fall through to
     * CTX_LANG_YAML and are re-classified by ctx_is_kustomize_file() in
     * pass_k8s.c, which performs a case-insensitive comparison.  This is the
     * intended behaviour — no additional entries are needed. */
    {".vimrc", CTX_LANG_VIMSCRIPT},
};

#define FILENAME_TABLE_SIZE (sizeof(FILENAME_TABLE) / sizeof(FILENAME_TABLE[0]))

/* ── Language names ──────────────────────────────────────────────── */

static const char *LANG_NAMES[CTX_LANG_COUNT] = {
    [CTX_LANG_GO] = "Go",
    [CTX_LANG_PYTHON] = "Python",
    [CTX_LANG_JAVASCRIPT] = "JavaScript",
    [CTX_LANG_TYPESCRIPT] = "TypeScript",
    [CTX_LANG_TSX] = "TSX",
    [CTX_LANG_RUST] = "Rust",
    [CTX_LANG_JAVA] = "Java",
    [CTX_LANG_CPP] = "C++",
    [CTX_LANG_CSHARP] = "C#",
    [CTX_LANG_PHP] = "PHP",
    [CTX_LANG_LUA] = "Lua",
    [CTX_LANG_SCALA] = "Scala",
    [CTX_LANG_KOTLIN] = "Kotlin",
    [CTX_LANG_RUBY] = "Ruby",
    [CTX_LANG_C] = "C",
    [CTX_LANG_BASH] = "Bash",
    [CTX_LANG_ZIG] = "Zig",
    [CTX_LANG_ELIXIR] = "Elixir",
    [CTX_LANG_HASKELL] = "Haskell",
    [CTX_LANG_OCAML] = "OCaml",
    [CTX_LANG_OBJC] = "Objective-C",
    [CTX_LANG_SWIFT] = "Swift",
    [CTX_LANG_DART] = "Dart",
    [CTX_LANG_PERL] = "Perl",
    [CTX_LANG_GROOVY] = "Groovy",
    [CTX_LANG_ERLANG] = "Erlang",
    [CTX_LANG_R] = "R",
    [CTX_LANG_HTML] = "HTML",
    [CTX_LANG_CSS] = "CSS",
    [CTX_LANG_SCSS] = "SCSS",
    [CTX_LANG_YAML] = "YAML",
    [CTX_LANG_TOML] = "TOML",
    [CTX_LANG_HCL] = "HCL",
    [CTX_LANG_SQL] = "SQL",
    [CTX_LANG_DOCKERFILE] = "Dockerfile",
    [CTX_LANG_CLOJURE] = "Clojure",
    [CTX_LANG_FSHARP] = "F#",
    [CTX_LANG_JULIA] = "Julia",
    [CTX_LANG_VIMSCRIPT] = "VimScript",
    [CTX_LANG_NIX] = "Nix",
    [CTX_LANG_COMMONLISP] = "Common Lisp",
    [CTX_LANG_ELM] = "Elm",
    [CTX_LANG_FORTRAN] = "Fortran",
    [CTX_LANG_CUDA] = "CUDA",
    [CTX_LANG_COBOL] = "COBOL",
    [CTX_LANG_VERILOG] = "Verilog",
    [CTX_LANG_EMACSLISP] = "Emacs Lisp",
    [CTX_LANG_JSON] = "JSON",
    [CTX_LANG_XML] = "XML",
    [CTX_LANG_MARKDOWN] = "Markdown",
    [CTX_LANG_MAKEFILE] = "Makefile",
    [CTX_LANG_CMAKE] = "CMake",
    [CTX_LANG_PROTOBUF] = "Protobuf",
    [CTX_LANG_GRAPHQL] = "GraphQL",
    [CTX_LANG_VUE] = "Vue",
    [CTX_LANG_SVELTE] = "Svelte",
    [CTX_LANG_MESON] = "Meson",
    [CTX_LANG_GLSL] = "GLSL",
    [CTX_LANG_INI] = "INI",
    [CTX_LANG_MATLAB] = "MATLAB",
    [CTX_LANG_LEAN] = "Lean",
    [CTX_LANG_FORM] = "FORM",
    [CTX_LANG_MAGMA] = "Magma",
    [CTX_LANG_WOLFRAM] = "Wolfram",
    [CTX_LANG_KUSTOMIZE] = "Kustomize",
    [CTX_LANG_K8S] = "Kubernetes",
};

/* ── Public API ──────────────────────────────────────────────────── */

CtxLanguage ctx_language_for_extension(const char *ext) {
    if (!ext || !ext[0]) {
        return CTX_LANG_COUNT;
    }

    /* Check user-defined overrides first */
    const ctx_userconfig_t *ucfg = ctx_get_user_lang_config();
    if (ucfg) {
        CtxLanguage ulang = ctx_userconfig_lookup(ucfg, ext);
        if (ulang != CTX_LANG_COUNT) {
            return ulang;
        }
    }

    for (size_t i = 0; i < EXT_TABLE_SIZE; i++) {
        if (strcmp(EXT_TABLE[i].ext, ext) == 0) {
            return EXT_TABLE[i].language;
        }
    }
    return CTX_LANG_COUNT;
}

CtxLanguage ctx_language_for_filename(const char *filename) {
    if (!filename || !filename[0]) {
        return CTX_LANG_COUNT;
    }

    /* Check special filenames first */
    for (size_t i = 0; i < FILENAME_TABLE_SIZE; i++) {
        if (strcmp(FILENAME_TABLE[i].filename, filename) == 0) {
            return FILENAME_TABLE[i].language;
        }
    }

    /* Fall back to extension-based lookup.
     * For compound extensions (e.g. ".blade.php") defined in the user config,
     * scan from the first dot in the basename toward the last, checking user
     * config at each position.  Built-in extensions use the last dot only. */
    const char *last_dot = strrchr(filename, '.');
    if (!last_dot) {
        return CTX_LANG_COUNT;
    }

    /* Probe user config for compound extensions (e.g. ".blade.php"). */
    const ctx_userconfig_t *ucfg = ctx_get_user_lang_config();
    if (ucfg) {
        const char *p = strchr(filename, '.');
        while (p && p < last_dot) {
            CtxLanguage lang = ctx_userconfig_lookup(ucfg, p);
            if (lang != CTX_LANG_COUNT) {
                return lang;
            }
            p = strchr(p + SKIP_ONE, '.');
        }
    }

    /* Standard single-extension lookup (built-ins + user overrides). */
    return ctx_language_for_extension(last_dot);
}

const char *ctx_language_name(CtxLanguage lang) {
    if (lang < 0 || lang >= CTX_LANG_COUNT) {
        return "Unknown";
    }
    return LANG_NAMES[lang] ? LANG_NAMES[lang] : "Unknown";
}

/* ── .m file disambiguation ──────────────────────────────────────── */

/* Simple substring search helper */
static bool str_contains(const char *haystack, const char *needle) {
    return strstr(haystack, needle) != NULL;
}

static bool has_objc_markers(const char *buf) {
    return str_contains(buf, "@interface") || str_contains(buf, "@implementation") ||
           str_contains(buf, "@protocol") || str_contains(buf, "@property") ||
           str_contains(buf, "#import") || str_contains(buf, "@selector") ||
           str_contains(buf, "@encode") || str_contains(buf, "@synthesize") ||
           str_contains(buf, "@dynamic");
}

static bool has_magma_end_markers(const char *buf) {
    return str_contains(buf, "end function;") || str_contains(buf, "end procedure;") ||
           str_contains(buf, "end intrinsic;") || str_contains(buf, "end if;") ||
           str_contains(buf, "end for;") || str_contains(buf, "end while;");
}

/* Check for "intrinsic Name(" or "procedure Name(" patterns. */
static bool has_magma_callable_pattern(const char *buf) {
    const char *markers[] = {"intrinsic ", "procedure "};
    for (int i = 0; i < LANG_SCAN_PASSES; i++) {
        const char *p = strstr(buf, markers[i]);
        if (!p) {
            continue;
        }
        p += strlen(markers[i]);
        while (*p && isalpha((unsigned char)*p)) {
            p++;
        }
        if (*p == '(') {
            return true;
        }
    }
    return false;
}

/* Scan lines for MATLAB-specific markers (function/classdef/%%). */
static bool has_matlab_line_markers(const char *buf) {
    const char *line = buf;
    while (*line) {
        const char *p = line;
        while (*p == ' ' || *p == '\t') {
            p++;
        }
        if (strncmp(p, "function ", SLEN("function ")) == 0 ||
            strncmp(p, "function\t", SLEN("function\t")) == 0 ||
            strncmp(p, "classdef ", SLEN("classdef ")) == 0 ||
            strncmp(p, "classdef\t", SLEN("classdef\t")) == 0 || strncmp(p, "%%", PAIR_LEN) == 0 ||
            (*p == '%' && *(p + SKIP_ONE) != '{')) {
            return true;
        }
        const char *nl = strchr(line, '\n');
        if (!nl) {
            break;
        }
        line = nl + SKIP_ONE;
    }
    return false;
}

CtxLanguage ctx_disambiguate_m(const char *path) {
    if (!path) {
        return CTX_LANG_MATLAB;
    }

    FILE *f = fopen(path, "r");
    if (!f) {
        return CTX_LANG_MATLAB;
    }

    /* Read first 4KB */
    char buf[CTX_SZ_4K + SKIP_ONE];
    size_t n = fread(buf, SKIP_ONE, CTX_SZ_4K, f);
    buf[n] = '\0';
    (void)fclose(f);

    if (has_objc_markers(buf)) {
        return CTX_LANG_OBJC;
    }
    if (has_magma_end_markers(buf)) {
        return CTX_LANG_MAGMA;
    }
    if ((str_contains(buf, "intrinsic ") || str_contains(buf, "procedure ")) &&
        has_magma_callable_pattern(buf)) {
        return CTX_LANG_MAGMA;
    }
    if (has_matlab_line_markers(buf)) {
        return CTX_LANG_MATLAB;
    }

    return CTX_LANG_MATLAB;
}
