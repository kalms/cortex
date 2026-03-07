package cbm

// GCC 15.2.0 (MSYS2 UCRT64) introduced a regression where __imp__wctype
// from corecrt_wctype.h is no longer a selectany weak symbol, causing
// "multiple definition" linker errors when many CGo object files are linked.
// --allow-multiple-definition is the standard workaround for large CGo projects.

/*
#cgo windows LDFLAGS: -Wl,--allow-multiple-definition
*/
import "C"
