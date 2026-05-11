/*
 * test_language.c — Tests for language detection (filename + extension).
 *
 * RED phase: These tests define the expected behavior for all 64 languages.
 */
#include "../src/foundation/compat.h"
#include "test_framework.h"
#include "discover/discover.h"

/* ── Extension-based detection ─────────────────────────────────── */

TEST(lang_ext_go) {
    ASSERT_EQ(ctx_language_for_extension(".go"), CTX_LANG_GO);
    PASS();
}
TEST(lang_ext_python) {
    ASSERT_EQ(ctx_language_for_extension(".py"), CTX_LANG_PYTHON);
    PASS();
}
TEST(lang_ext_javascript) {
    ASSERT_EQ(ctx_language_for_extension(".js"), CTX_LANG_JAVASCRIPT);
    PASS();
}
TEST(lang_ext_jsx) {
    ASSERT_EQ(ctx_language_for_extension(".jsx"), CTX_LANG_JAVASCRIPT);
    PASS();
}
TEST(lang_ext_typescript) {
    ASSERT_EQ(ctx_language_for_extension(".ts"), CTX_LANG_TYPESCRIPT);
    PASS();
}
TEST(lang_ext_tsx) {
    ASSERT_EQ(ctx_language_for_extension(".tsx"), CTX_LANG_TSX);
    PASS();
}
TEST(lang_ext_rust) {
    ASSERT_EQ(ctx_language_for_extension(".rs"), CTX_LANG_RUST);
    PASS();
}
TEST(lang_ext_java) {
    ASSERT_EQ(ctx_language_for_extension(".java"), CTX_LANG_JAVA);
    PASS();
}
TEST(lang_ext_cpp) {
    ASSERT_EQ(ctx_language_for_extension(".cpp"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_hpp) {
    ASSERT_EQ(ctx_language_for_extension(".hpp"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_cc) {
    ASSERT_EQ(ctx_language_for_extension(".cc"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_cxx) {
    ASSERT_EQ(ctx_language_for_extension(".cxx"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_hxx) {
    ASSERT_EQ(ctx_language_for_extension(".hxx"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_hh) {
    ASSERT_EQ(ctx_language_for_extension(".hh"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_h) {
    ASSERT_EQ(ctx_language_for_extension(".h"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_ixx) {
    ASSERT_EQ(ctx_language_for_extension(".ixx"), CTX_LANG_CPP);
    PASS();
}
TEST(lang_ext_csharp) {
    ASSERT_EQ(ctx_language_for_extension(".cs"), CTX_LANG_CSHARP);
    PASS();
}
TEST(lang_ext_php) {
    ASSERT_EQ(ctx_language_for_extension(".php"), CTX_LANG_PHP);
    PASS();
}
TEST(lang_ext_lua) {
    ASSERT_EQ(ctx_language_for_extension(".lua"), CTX_LANG_LUA);
    PASS();
}
TEST(lang_ext_scala) {
    ASSERT_EQ(ctx_language_for_extension(".scala"), CTX_LANG_SCALA);
    PASS();
}
TEST(lang_ext_sc) {
    ASSERT_EQ(ctx_language_for_extension(".sc"), CTX_LANG_SCALA);
    PASS();
}
TEST(lang_ext_kotlin) {
    ASSERT_EQ(ctx_language_for_extension(".kt"), CTX_LANG_KOTLIN);
    PASS();
}
TEST(lang_ext_kts) {
    ASSERT_EQ(ctx_language_for_extension(".kts"), CTX_LANG_KOTLIN);
    PASS();
}
TEST(lang_ext_ruby) {
    ASSERT_EQ(ctx_language_for_extension(".rb"), CTX_LANG_RUBY);
    PASS();
}
TEST(lang_ext_rake) {
    ASSERT_EQ(ctx_language_for_extension(".rake"), CTX_LANG_RUBY);
    PASS();
}
TEST(lang_ext_gemspec) {
    ASSERT_EQ(ctx_language_for_extension(".gemspec"), CTX_LANG_RUBY);
    PASS();
}
TEST(lang_ext_c) {
    ASSERT_EQ(ctx_language_for_extension(".c"), CTX_LANG_C);
    PASS();
}
TEST(lang_ext_bash) {
    ASSERT_EQ(ctx_language_for_extension(".sh"), CTX_LANG_BASH);
    PASS();
}
TEST(lang_ext_bash2) {
    ASSERT_EQ(ctx_language_for_extension(".bash"), CTX_LANG_BASH);
    PASS();
}
TEST(lang_ext_zig) {
    ASSERT_EQ(ctx_language_for_extension(".zig"), CTX_LANG_ZIG);
    PASS();
}
TEST(lang_ext_elixir) {
    ASSERT_EQ(ctx_language_for_extension(".ex"), CTX_LANG_ELIXIR);
    PASS();
}
TEST(lang_ext_exs) {
    ASSERT_EQ(ctx_language_for_extension(".exs"), CTX_LANG_ELIXIR);
    PASS();
}
TEST(lang_ext_haskell) {
    ASSERT_EQ(ctx_language_for_extension(".hs"), CTX_LANG_HASKELL);
    PASS();
}
TEST(lang_ext_ocaml) {
    ASSERT_EQ(ctx_language_for_extension(".ml"), CTX_LANG_OCAML);
    PASS();
}
TEST(lang_ext_mli) {
    ASSERT_EQ(ctx_language_for_extension(".mli"), CTX_LANG_OCAML);
    PASS();
}
TEST(lang_ext_swift) {
    ASSERT_EQ(ctx_language_for_extension(".swift"), CTX_LANG_SWIFT);
    PASS();
}
TEST(lang_ext_dart) {
    ASSERT_EQ(ctx_language_for_extension(".dart"), CTX_LANG_DART);
    PASS();
}
TEST(lang_ext_perl) {
    ASSERT_EQ(ctx_language_for_extension(".pl"), CTX_LANG_PERL);
    PASS();
}
TEST(lang_ext_pm) {
    ASSERT_EQ(ctx_language_for_extension(".pm"), CTX_LANG_PERL);
    PASS();
}
TEST(lang_ext_groovy) {
    ASSERT_EQ(ctx_language_for_extension(".groovy"), CTX_LANG_GROOVY);
    PASS();
}
TEST(lang_ext_gradle) {
    ASSERT_EQ(ctx_language_for_extension(".gradle"), CTX_LANG_GROOVY);
    PASS();
}
TEST(lang_ext_erlang) {
    ASSERT_EQ(ctx_language_for_extension(".erl"), CTX_LANG_ERLANG);
    PASS();
}
TEST(lang_ext_r) {
    ASSERT_EQ(ctx_language_for_extension(".r"), CTX_LANG_R);
    PASS();
}
TEST(lang_ext_R) {
    ASSERT_EQ(ctx_language_for_extension(".R"), CTX_LANG_R);
    PASS();
}

/* Tier 2 programming */
TEST(lang_ext_clojure) {
    ASSERT_EQ(ctx_language_for_extension(".clj"), CTX_LANG_CLOJURE);
    PASS();
}
TEST(lang_ext_cljs) {
    ASSERT_EQ(ctx_language_for_extension(".cljs"), CTX_LANG_CLOJURE);
    PASS();
}
TEST(lang_ext_cljc) {
    ASSERT_EQ(ctx_language_for_extension(".cljc"), CTX_LANG_CLOJURE);
    PASS();
}
TEST(lang_ext_fsharp) {
    ASSERT_EQ(ctx_language_for_extension(".fs"), CTX_LANG_FSHARP);
    PASS();
}
TEST(lang_ext_fsi) {
    ASSERT_EQ(ctx_language_for_extension(".fsi"), CTX_LANG_FSHARP);
    PASS();
}
TEST(lang_ext_fsx) {
    ASSERT_EQ(ctx_language_for_extension(".fsx"), CTX_LANG_FSHARP);
    PASS();
}
TEST(lang_ext_julia) {
    ASSERT_EQ(ctx_language_for_extension(".jl"), CTX_LANG_JULIA);
    PASS();
}
TEST(lang_ext_vim) {
    ASSERT_EQ(ctx_language_for_extension(".vim"), CTX_LANG_VIMSCRIPT);
    PASS();
}
TEST(lang_ext_nix) {
    ASSERT_EQ(ctx_language_for_extension(".nix"), CTX_LANG_NIX);
    PASS();
}
TEST(lang_ext_commonlisp) {
    ASSERT_EQ(ctx_language_for_extension(".lisp"), CTX_LANG_COMMONLISP);
    PASS();
}
TEST(lang_ext_lsp) {
    ASSERT_EQ(ctx_language_for_extension(".lsp"), CTX_LANG_COMMONLISP);
    PASS();
}
TEST(lang_ext_cl) {
    ASSERT_EQ(ctx_language_for_extension(".cl"), CTX_LANG_COMMONLISP);
    PASS();
}
TEST(lang_ext_elm) {
    ASSERT_EQ(ctx_language_for_extension(".elm"), CTX_LANG_ELM);
    PASS();
}
TEST(lang_ext_fortran) {
    ASSERT_EQ(ctx_language_for_extension(".f90"), CTX_LANG_FORTRAN);
    PASS();
}
TEST(lang_ext_f95) {
    ASSERT_EQ(ctx_language_for_extension(".f95"), CTX_LANG_FORTRAN);
    PASS();
}
TEST(lang_ext_f03) {
    ASSERT_EQ(ctx_language_for_extension(".f03"), CTX_LANG_FORTRAN);
    PASS();
}
TEST(lang_ext_f08) {
    ASSERT_EQ(ctx_language_for_extension(".f08"), CTX_LANG_FORTRAN);
    PASS();
}
TEST(lang_ext_cuda) {
    ASSERT_EQ(ctx_language_for_extension(".cu"), CTX_LANG_CUDA);
    PASS();
}
TEST(lang_ext_cuh) {
    ASSERT_EQ(ctx_language_for_extension(".cuh"), CTX_LANG_CUDA);
    PASS();
}
TEST(lang_ext_cobol) {
    ASSERT_EQ(ctx_language_for_extension(".cob"), CTX_LANG_COBOL);
    PASS();
}
TEST(lang_ext_cbl) {
    ASSERT_EQ(ctx_language_for_extension(".cbl"), CTX_LANG_COBOL);
    PASS();
}
TEST(lang_ext_verilog) {
    ASSERT_EQ(ctx_language_for_extension(".v"), CTX_LANG_VERILOG);
    PASS();
}
TEST(lang_ext_sv) {
    ASSERT_EQ(ctx_language_for_extension(".sv"), CTX_LANG_VERILOG);
    PASS();
}
TEST(lang_ext_emacslisp) {
    ASSERT_EQ(ctx_language_for_extension(".el"), CTX_LANG_EMACSLISP);
    PASS();
}

/* Scientific/math */
TEST(lang_ext_matlab) {
    ASSERT_EQ(ctx_language_for_extension(".matlab"), CTX_LANG_MATLAB);
    PASS();
}
TEST(lang_ext_mlx) {
    ASSERT_EQ(ctx_language_for_extension(".mlx"), CTX_LANG_MATLAB);
    PASS();
}
TEST(lang_ext_lean) {
    ASSERT_EQ(ctx_language_for_extension(".lean"), CTX_LANG_LEAN);
    PASS();
}
TEST(lang_ext_form) {
    ASSERT_EQ(ctx_language_for_extension(".frm"), CTX_LANG_FORM);
    PASS();
}
TEST(lang_ext_prc) {
    ASSERT_EQ(ctx_language_for_extension(".prc"), CTX_LANG_FORM);
    PASS();
}
TEST(lang_ext_magma) {
    ASSERT_EQ(ctx_language_for_extension(".mag"), CTX_LANG_MAGMA);
    PASS();
}
TEST(lang_ext_magma2) {
    ASSERT_EQ(ctx_language_for_extension(".magma"), CTX_LANG_MAGMA);
    PASS();
}
TEST(lang_ext_wolfram) {
    ASSERT_EQ(ctx_language_for_extension(".wl"), CTX_LANG_WOLFRAM);
    PASS();
}
TEST(lang_ext_wls) {
    ASSERT_EQ(ctx_language_for_extension(".wls"), CTX_LANG_WOLFRAM);
    PASS();
}

/* Helper languages */
TEST(lang_ext_html) {
    ASSERT_EQ(ctx_language_for_extension(".html"), CTX_LANG_HTML);
    PASS();
}
TEST(lang_ext_htm) {
    ASSERT_EQ(ctx_language_for_extension(".htm"), CTX_LANG_HTML);
    PASS();
}
TEST(lang_ext_css) {
    ASSERT_EQ(ctx_language_for_extension(".css"), CTX_LANG_CSS);
    PASS();
}
TEST(lang_ext_scss) {
    ASSERT_EQ(ctx_language_for_extension(".scss"), CTX_LANG_SCSS);
    PASS();
}
TEST(lang_ext_yaml) {
    ASSERT_EQ(ctx_language_for_extension(".yml"), CTX_LANG_YAML);
    PASS();
}
TEST(lang_ext_yaml2) {
    ASSERT_EQ(ctx_language_for_extension(".yaml"), CTX_LANG_YAML);
    PASS();
}
TEST(lang_ext_toml) {
    ASSERT_EQ(ctx_language_for_extension(".toml"), CTX_LANG_TOML);
    PASS();
}
TEST(lang_ext_hcl) {
    ASSERT_EQ(ctx_language_for_extension(".tf"), CTX_LANG_HCL);
    PASS();
}
TEST(lang_ext_hcl2) {
    ASSERT_EQ(ctx_language_for_extension(".hcl"), CTX_LANG_HCL);
    PASS();
}
TEST(lang_ext_sql) {
    ASSERT_EQ(ctx_language_for_extension(".sql"), CTX_LANG_SQL);
    PASS();
}
TEST(lang_ext_dockerfile) {
    ASSERT_EQ(ctx_language_for_extension(".dockerfile"), CTX_LANG_DOCKERFILE);
    PASS();
}
TEST(lang_ext_json) {
    ASSERT_EQ(ctx_language_for_extension(".json"), CTX_LANG_JSON);
    PASS();
}
TEST(lang_ext_xml) {
    ASSERT_EQ(ctx_language_for_extension(".xml"), CTX_LANG_XML);
    PASS();
}
TEST(lang_ext_xsl) {
    ASSERT_EQ(ctx_language_for_extension(".xsl"), CTX_LANG_XML);
    PASS();
}
TEST(lang_ext_xsd) {
    ASSERT_EQ(ctx_language_for_extension(".xsd"), CTX_LANG_XML);
    PASS();
}
TEST(lang_ext_svg) {
    ASSERT_EQ(ctx_language_for_extension(".svg"), CTX_LANG_XML);
    PASS();
}
TEST(lang_ext_markdown) {
    ASSERT_EQ(ctx_language_for_extension(".md"), CTX_LANG_MARKDOWN);
    PASS();
}
TEST(lang_ext_mdx) {
    ASSERT_EQ(ctx_language_for_extension(".mdx"), CTX_LANG_MARKDOWN);
    PASS();
}
TEST(lang_ext_makefile) {
    ASSERT_EQ(ctx_language_for_extension(".mk"), CTX_LANG_MAKEFILE);
    PASS();
}
TEST(lang_ext_cmake) {
    ASSERT_EQ(ctx_language_for_extension(".cmake"), CTX_LANG_CMAKE);
    PASS();
}
TEST(lang_ext_protobuf) {
    ASSERT_EQ(ctx_language_for_extension(".proto"), CTX_LANG_PROTOBUF);
    PASS();
}
TEST(lang_ext_graphql) {
    ASSERT_EQ(ctx_language_for_extension(".graphql"), CTX_LANG_GRAPHQL);
    PASS();
}
TEST(lang_ext_gql) {
    ASSERT_EQ(ctx_language_for_extension(".gql"), CTX_LANG_GRAPHQL);
    PASS();
}
TEST(lang_ext_vue) {
    ASSERT_EQ(ctx_language_for_extension(".vue"), CTX_LANG_VUE);
    PASS();
}
TEST(lang_ext_svelte) {
    ASSERT_EQ(ctx_language_for_extension(".svelte"), CTX_LANG_SVELTE);
    PASS();
}
TEST(lang_ext_meson) {
    ASSERT_EQ(ctx_language_for_extension(".meson"), CTX_LANG_MESON);
    PASS();
}
TEST(lang_ext_glsl) {
    ASSERT_EQ(ctx_language_for_extension(".glsl"), CTX_LANG_GLSL);
    PASS();
}
TEST(lang_ext_vert) {
    ASSERT_EQ(ctx_language_for_extension(".vert"), CTX_LANG_GLSL);
    PASS();
}
TEST(lang_ext_frag) {
    ASSERT_EQ(ctx_language_for_extension(".frag"), CTX_LANG_GLSL);
    PASS();
}
TEST(lang_ext_ini) {
    ASSERT_EQ(ctx_language_for_extension(".ini"), CTX_LANG_INI);
    PASS();
}
TEST(lang_ext_cfg) {
    ASSERT_EQ(ctx_language_for_extension(".cfg"), CTX_LANG_INI);
    PASS();
}
TEST(lang_ext_conf) {
    ASSERT_EQ(ctx_language_for_extension(".conf"), CTX_LANG_INI);
    PASS();
}

/* Unknown extension */
TEST(lang_ext_unknown) {
    ASSERT_EQ(ctx_language_for_extension(".xyz"), CTX_LANG_COUNT);
    PASS();
}
TEST(lang_ext_null) {
    ASSERT_EQ(ctx_language_for_extension(""), CTX_LANG_COUNT);
    PASS();
}

/* ── Filename-based detection ──────────────────────────────────── */

TEST(lang_fn_makefile) {
    ASSERT_EQ(ctx_language_for_filename("Makefile"), CTX_LANG_MAKEFILE);
    PASS();
}
TEST(lang_fn_gnumakefile) {
    ASSERT_EQ(ctx_language_for_filename("GNUmakefile"), CTX_LANG_MAKEFILE);
    PASS();
}
TEST(lang_fn_makefile_lower) {
    ASSERT_EQ(ctx_language_for_filename("makefile"), CTX_LANG_MAKEFILE);
    PASS();
}
TEST(lang_fn_cmake) {
    ASSERT_EQ(ctx_language_for_filename("CMakeLists.txt"), CTX_LANG_CMAKE);
    PASS();
}
TEST(lang_fn_dockerfile) {
    ASSERT_EQ(ctx_language_for_filename("Dockerfile"), CTX_LANG_DOCKERFILE);
    PASS();
}
TEST(lang_fn_meson_build) {
    ASSERT_EQ(ctx_language_for_filename("meson.build"), CTX_LANG_MESON);
    PASS();
}
TEST(lang_fn_meson_opts) {
    ASSERT_EQ(ctx_language_for_filename("meson.options"), CTX_LANG_MESON);
    PASS();
}
TEST(lang_fn_meson_opts_txt) {
    ASSERT_EQ(ctx_language_for_filename("meson_options.txt"), CTX_LANG_MESON);
    PASS();
}
TEST(lang_fn_vimrc) {
    ASSERT_EQ(ctx_language_for_filename(".vimrc"), CTX_LANG_VIMSCRIPT);
    PASS();
}

/* Filename with extension falls through to extension lookup */
TEST(lang_fn_main_go) {
    ASSERT_EQ(ctx_language_for_filename("main.go"), CTX_LANG_GO);
    PASS();
}
TEST(lang_fn_test_py) {
    ASSERT_EQ(ctx_language_for_filename("test.py"), CTX_LANG_PYTHON);
    PASS();
}
TEST(lang_fn_unknown) {
    ASSERT_EQ(ctx_language_for_filename("README"), CTX_LANG_COUNT);
    PASS();
}

/* ── Language name ─────────────────────────────────────────────── */

TEST(lang_name_go) {
    ASSERT_STR_EQ(ctx_language_name(CTX_LANG_GO), "Go");
    PASS();
}
TEST(lang_name_python) {
    ASSERT_STR_EQ(ctx_language_name(CTX_LANG_PYTHON), "Python");
    PASS();
}
TEST(lang_name_cpp) {
    ASSERT_STR_EQ(ctx_language_name(CTX_LANG_CPP), "C++");
    PASS();
}
TEST(lang_name_csharp) {
    ASSERT_STR_EQ(ctx_language_name(CTX_LANG_CSHARP), "C#");
    PASS();
}
TEST(lang_name_unknown) {
    ASSERT_STR_EQ(ctx_language_name(CTX_LANG_COUNT), "Unknown");
    PASS();
}

/* ── .m disambiguation ─────────────────────────────────────────── */

/* These tests need temp files with content markers */
TEST(lang_m_objc) {
    /* Write a temp file with Objective-C markers */
    char path[256]; snprintf(path, sizeof(path), "%s/test_lang_objc.m", ctx_tmpdir());
    FILE *f = fopen(path, "w");
    ASSERT_NOT_NULL(f);
    fprintf(f, "#import <Foundation/Foundation.h>\n@interface Foo : NSObject\n@end\n");
    fclose(f);

    ASSERT_EQ(ctx_disambiguate_m(path), CTX_LANG_OBJC);
    remove(path);
    PASS();
}

TEST(lang_m_magma) {
    char path[256]; snprintf(path, sizeof(path), "%s/test_lang_magma.m", ctx_tmpdir());
    FILE *f = fopen(path, "w");
    ASSERT_NOT_NULL(f);
    fprintf(f, "function MyFunc(x)\n  return x^2;\nend function;\n");
    fclose(f);

    ASSERT_EQ(ctx_disambiguate_m(path), CTX_LANG_MAGMA);
    remove(path);
    PASS();
}

TEST(lang_m_matlab) {
    char path[256]; snprintf(path, sizeof(path), "%s/test_lang_matlab.m", ctx_tmpdir());
    FILE *f = fopen(path, "w");
    ASSERT_NOT_NULL(f);
    fprintf(f, "function y = square(x)\n  y = x.^2;\nend\n");
    fclose(f);

    ASSERT_EQ(ctx_disambiguate_m(path), CTX_LANG_MATLAB);
    remove(path);
    PASS();
}

TEST(lang_m_default_on_read_fail) {
    /* Non-existent file defaults to MATLAB */
    ASSERT_EQ(ctx_disambiguate_m("/tmp/nonexistent_file_12345.m"), CTX_LANG_MATLAB);
    PASS();
}

/* --- Ported from lang_test.go: TestForLanguage --- */
TEST(lang_all_have_names) {
    /* Every language enum value from 0 to CTX_LANG_COUNT-1
     * should have a non-"Unknown" name. */
    for (int i = 0; i < CTX_LANG_COUNT; i++) {
        const char *name = ctx_language_name((CtxLanguage)i);
        ASSERT_NOT_NULL(name);
        ASSERT_TRUE(strcmp(name, "Unknown") != 0);
    }
    PASS();
}

/* ── Suite ─────────────────────────────────────────────────────── */

SUITE(language) {
    /* Extension: Tier 1 programming */
    RUN_TEST(lang_ext_go);
    RUN_TEST(lang_ext_python);
    RUN_TEST(lang_ext_javascript);
    RUN_TEST(lang_ext_jsx);
    RUN_TEST(lang_ext_typescript);
    RUN_TEST(lang_ext_tsx);
    RUN_TEST(lang_ext_rust);
    RUN_TEST(lang_ext_java);
    RUN_TEST(lang_ext_cpp);
    RUN_TEST(lang_ext_hpp);
    RUN_TEST(lang_ext_cc);
    RUN_TEST(lang_ext_cxx);
    RUN_TEST(lang_ext_hxx);
    RUN_TEST(lang_ext_hh);
    RUN_TEST(lang_ext_h);
    RUN_TEST(lang_ext_ixx);
    RUN_TEST(lang_ext_csharp);
    RUN_TEST(lang_ext_php);
    RUN_TEST(lang_ext_lua);
    RUN_TEST(lang_ext_scala);
    RUN_TEST(lang_ext_sc);
    RUN_TEST(lang_ext_kotlin);
    RUN_TEST(lang_ext_kts);
    RUN_TEST(lang_ext_ruby);
    RUN_TEST(lang_ext_rake);
    RUN_TEST(lang_ext_gemspec);
    RUN_TEST(lang_ext_c);
    RUN_TEST(lang_ext_bash);
    RUN_TEST(lang_ext_bash2);
    RUN_TEST(lang_ext_zig);
    RUN_TEST(lang_ext_elixir);
    RUN_TEST(lang_ext_exs);
    RUN_TEST(lang_ext_haskell);
    RUN_TEST(lang_ext_ocaml);
    RUN_TEST(lang_ext_mli);
    RUN_TEST(lang_ext_swift);
    RUN_TEST(lang_ext_dart);
    RUN_TEST(lang_ext_perl);
    RUN_TEST(lang_ext_pm);
    RUN_TEST(lang_ext_groovy);
    RUN_TEST(lang_ext_gradle);
    RUN_TEST(lang_ext_erlang);
    RUN_TEST(lang_ext_r);
    RUN_TEST(lang_ext_R);

    /* Extension: Tier 2 programming */
    RUN_TEST(lang_ext_clojure);
    RUN_TEST(lang_ext_cljs);
    RUN_TEST(lang_ext_cljc);
    RUN_TEST(lang_ext_fsharp);
    RUN_TEST(lang_ext_fsi);
    RUN_TEST(lang_ext_fsx);
    RUN_TEST(lang_ext_julia);
    RUN_TEST(lang_ext_vim);
    RUN_TEST(lang_ext_nix);
    RUN_TEST(lang_ext_commonlisp);
    RUN_TEST(lang_ext_lsp);
    RUN_TEST(lang_ext_cl);
    RUN_TEST(lang_ext_elm);
    RUN_TEST(lang_ext_fortran);
    RUN_TEST(lang_ext_f95);
    RUN_TEST(lang_ext_f03);
    RUN_TEST(lang_ext_f08);
    RUN_TEST(lang_ext_cuda);
    RUN_TEST(lang_ext_cuh);
    RUN_TEST(lang_ext_cobol);
    RUN_TEST(lang_ext_cbl);
    RUN_TEST(lang_ext_verilog);
    RUN_TEST(lang_ext_sv);
    RUN_TEST(lang_ext_emacslisp);

    /* Extension: Scientific/math */
    RUN_TEST(lang_ext_matlab);
    RUN_TEST(lang_ext_mlx);
    RUN_TEST(lang_ext_lean);
    RUN_TEST(lang_ext_form);
    RUN_TEST(lang_ext_prc);
    RUN_TEST(lang_ext_magma);
    RUN_TEST(lang_ext_magma2);
    RUN_TEST(lang_ext_wolfram);
    RUN_TEST(lang_ext_wls);

    /* Extension: Helper languages */
    RUN_TEST(lang_ext_html);
    RUN_TEST(lang_ext_htm);
    RUN_TEST(lang_ext_css);
    RUN_TEST(lang_ext_scss);
    RUN_TEST(lang_ext_yaml);
    RUN_TEST(lang_ext_yaml2);
    RUN_TEST(lang_ext_toml);
    RUN_TEST(lang_ext_hcl);
    RUN_TEST(lang_ext_hcl2);
    RUN_TEST(lang_ext_sql);
    RUN_TEST(lang_ext_dockerfile);
    RUN_TEST(lang_ext_json);
    RUN_TEST(lang_ext_xml);
    RUN_TEST(lang_ext_xsl);
    RUN_TEST(lang_ext_xsd);
    RUN_TEST(lang_ext_svg);
    RUN_TEST(lang_ext_markdown);
    RUN_TEST(lang_ext_mdx);
    RUN_TEST(lang_ext_makefile);
    RUN_TEST(lang_ext_cmake);
    RUN_TEST(lang_ext_protobuf);
    RUN_TEST(lang_ext_graphql);
    RUN_TEST(lang_ext_gql);
    RUN_TEST(lang_ext_vue);
    RUN_TEST(lang_ext_svelte);
    RUN_TEST(lang_ext_meson);
    RUN_TEST(lang_ext_glsl);
    RUN_TEST(lang_ext_vert);
    RUN_TEST(lang_ext_frag);
    RUN_TEST(lang_ext_ini);
    RUN_TEST(lang_ext_cfg);
    RUN_TEST(lang_ext_conf);

    /* Unknown/edge cases */
    RUN_TEST(lang_ext_unknown);
    RUN_TEST(lang_ext_null);

    /* Filename-based */
    RUN_TEST(lang_fn_makefile);
    RUN_TEST(lang_fn_gnumakefile);
    RUN_TEST(lang_fn_makefile_lower);
    RUN_TEST(lang_fn_cmake);
    RUN_TEST(lang_fn_dockerfile);
    RUN_TEST(lang_fn_meson_build);
    RUN_TEST(lang_fn_meson_opts);
    RUN_TEST(lang_fn_meson_opts_txt);
    RUN_TEST(lang_fn_vimrc);
    RUN_TEST(lang_fn_main_go);
    RUN_TEST(lang_fn_test_py);
    RUN_TEST(lang_fn_unknown);

    /* Language names */
    RUN_TEST(lang_name_go);
    RUN_TEST(lang_name_python);
    RUN_TEST(lang_name_cpp);
    RUN_TEST(lang_name_csharp);
    RUN_TEST(lang_name_unknown);

    /* .m disambiguation */
    RUN_TEST(lang_m_objc);
    RUN_TEST(lang_m_magma);
    RUN_TEST(lang_m_matlab);
    RUN_TEST(lang_m_default_on_read_fail);

    /* Go test ports */
    RUN_TEST(lang_all_have_names);
}
