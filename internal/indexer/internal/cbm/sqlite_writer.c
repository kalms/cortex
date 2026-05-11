// sqlite_writer.c — Direct SQLite page writer.
// Constructs a valid .db file from sorted in-memory data without using
// the SQL parser, INSERT statements, or B-tree rebalancing.
//
// SQLite file format reference: https://www.sqlite.org/fileformat2.html
//
// Key invariants:
//   - Page size: 4096 bytes
//   - Page 1 has a 100-byte database header before the B-tree header
//   - Leaf table B-tree pages: flag 0x0D
//   - Interior table B-tree pages: flag 0x05
//   - Leaf index B-tree pages: flag 0x0A
//   - Interior index B-tree pages: flag 0x02
//   - Records: header (varint count + serial types) + body (column values)
//   - Varints: 1-9 bytes, big-endian, MSB continuation

#include "sqlite_writer.h"
#include "foundation/constants.h"
#include "foundation/compat_thread.h"
#include "foundation/profile.h"

#include <stddef.h> // NULL
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <ctype.h>

#define CTX_PAGE_SIZE 65536

/* SQLite reserves the page containing the 1 GiB file offset (the "pending byte"
 * used for file locking on Windows). This page MUST be skipped during allocation
 * otherwise integrity_check reports "2nd reference to page N" because it marks
 * this page as referenced before walking any tree.
 *
 * PENDING_BYTE = 0x40000000 = 1073741824 (1 GiB)
 * PENDING_BYTE_PAGE = (PENDING_BYTE / page_size) + 1
 *   64KB pages → page 16385
 *   32KB pages → page 32769
 *   16KB pages → page 65537
 */
#define SQLITE_MAX_PAGE_SIZE 65536
#define CTX_PENDING_BYTE (0x40000000u)
#define CTX_PENDING_BYTE_PAGE ((CTX_PENDING_BYTE / CTX_PAGE_SIZE) + 1)

/* Skip the pending byte page if allocation lands on it. */
static inline uint32_t ctx_skip_pending_byte(uint32_t pgno) {
    return pgno == CTX_PENDING_BYTE_PAGE ? pgno + SKIP_ONE : pgno;
}
#define SCHEMA_FORMAT 4
#define FILE_FORMAT 1
#define SQLITE_VERSION 3046000 // 3.46.0

// Varint encoding constants.
#define VARINT_MASK 0x7f
#define VARINT_CONTINUE 0x80
#define BYTE_MASK 0xff

enum {
    VARINT_SHIFT = 7,
    VARINT_BUF_SIZE = 10,
    VARINT_MIN_LEN = 1,
    SERIAL_INT8 = 1,
    SERIAL_INT16 = 2,
    SERIAL_INT24 = 3,
    SERIAL_INT32 = 4,
    SERIAL_INT48 = 5,
    SERIAL_INT64 = 6,
    SERIAL_FLOAT64 = 7,
    SERIAL_CONST_ZERO = 8,
    SERIAL_CONST_ONE = 9,
    SERIAL_SIZE_INT8 = 1,
    SERIAL_SIZE_INT16 = 2,
    SERIAL_SIZE_INT24 = 3,
    SERIAL_SIZE_INT32 = 4,
    SERIAL_SIZE_INT48 = 6,
    SERIAL_SIZE_INT64 = 8,
    BTREE_HEADER_SIZE = 8,
    BTREE_INTERIOR_HDR = 12,
    BTREE_PTR_SIZE = 4,
    CELL_PTR_SIZE = 2,
    INITIAL_PAGE_CAP = 4096,
    INITIAL_LEAF_CAP = 256,
    INITIAL_PARENT_CAP = 64,
    GROWTH_FACTOR = 2,
    VARINT_MAX_BYTES = 9,
    INT64_BYTES = 8,
    SORT_THRESHOLD = 20,
    MAX_NAME_LEN = 64,
    HASH_INIT = 5381,
    HASH_MULT = 33,
    HDR_FREEBLOCK_OFF = 1,
    HDR_CELLCOUNT_OFF = 3,
    HDR_CONTENT_OFF = 5,
    HDR_FRAGBYTES_OFF = 7,
    HDR_RIGHTCHILD_OFF = 8,
    INTERIOR_TABLE_FLAG = 0x05,
    INTERIOR_INDEX_FLAG = 0x02,
    NEWLINE_BYTE = 0x0A,
    /* New schema: nodes has 7 user indexes (kind, name, qn, file, tier,
     * kind+project, kind+file_path). Edges has 4 (source, target, relation,
     * project+relation). Total sorts = 7+4 = 11. */
    NODE_SORT_THREADS = 7,
    EDGE_SORT_THREADS = 4,
    TOTAL_SORT_THREADS = 11,
    ERR_SORT_FAILED = -4,
    ERR_WRITE_FAILED = -3,
    ERR_MASTER_OVERFLOW = -2,
    MAX_EMBED_FRACTION = 64,
    MIN_EMBED_FRACTION = 32,
    LEAF_PAYLOAD_FRACTION = 32,
    INTERIOR_CELL_BUF = 20,
    FIRST_ROWID = 1,
    FIRST_DATA_PAGE = 2,
    /* Node sort indexes */
    NSORT_NAME = 1,
    NSORT_QN = 2,
    NSORT_FILE = 3,
    NSORT_TIER = 4,
    NSORT_KIND_PROJECT = 5,
    NSORT_KIND_FILE = 6,
    /* Edge sort indexes */
    ESORT_TARGET = 1,
    ESORT_RELATION = 2,
    ESORT_PROJ_RELATION = 3,
    SQLITE_HEADER_SIZE = 100,
    SHIFT_8 = 8,
    SHIFT_16 = 16,
    SHIFT_24 = 24,
};
#define TEXT_SERIAL_BASE 13

// SQLite text serial type offset: serial_type = len*2 + TEXT_SERIAL_BASE.
#define TEXT_SERIAL_BASE 13

// SQLite blob serial type offset: serial_type = len*2 + BLOB_SERIAL_BASE.
#define BLOB_SERIAL_BASE 12
#define BLOB_SERIAL_MUL 2 /* serial_type = len * BLOB_SERIAL_MUL + BLOB_SERIAL_BASE */

// SQLite integer storage range limits.
#define INT8_MAX_VAL 127
#define INT16_MAX_VAL 32767
#define INT24_MIN_VAL (-8388608)
#define INT24_MAX_VAL 8388607
#define INT32_MIN_VAL (-2147483648LL)
#define INT32_MAX_VAL 2147483647LL
#define INT48_MIN_VAL (-140737488355328LL)
#define INT48_MAX_VAL 140737488355327LL

// SQLite B-tree page type flags.
#define BTREE_LEAF_TABLE 0x0D
#define BTREE_INTERIOR_TABLE 0x05
#define BTREE_LEAF_INDEX 0x0A
#define BTREE_INTERIOR_INDEX 0x02

// SQLite 100-byte database header field offsets.
#define HDR_OFF_CTX_PAGE_SIZE 16
#define HDR_OFF_WRITE_VERSION 18
#define HDR_OFF_READ_VERSION 19
#define HDR_OFF_RESERVED 20
#define HDR_OFF_MAX_EMBED_FRAC 21
#define HDR_OFF_MIN_EMBED_FRAC 22
#define HDR_OFF_LEAF_FRAC 23
#define HDR_OFF_FILE_CHANGE 24
#define HDR_OFF_DB_SIZE 28
#define HDR_OFF_FREELIST_TRUNK 32
#define HDR_OFF_FREELIST_COUNT 36
#define HDR_OFF_SCHEMA_COOKIE 40
#define HDR_OFF_SCHEMA_FORMAT 44
#define HDR_OFF_DEFAULT_CACHE 48
#define HDR_OFF_AUTOVAC_TOP 52
#define HDR_OFF_TEXT_ENCODING 56
#define HDR_OFF_USER_VERSION 60
#define HDR_OFF_INCR_VACUUM 64
#define HDR_OFF_APP_ID 68
#define HDR_OFF_VERSION_VALID 92
#define HDR_OFF_SQLITE_VERSION 96

// --- Varint encoding ---

static int put_varint(uint8_t *buf, int64_t value) {
    uint64_t v = (uint64_t)value;
    if (v <= VARINT_MASK) {
        buf[0] = (uint8_t)v;
        return SERIAL_SIZE_INT8;
    }
    // Encode in big-endian with MSB continuation bits
    uint8_t tmp[VARINT_BUF_SIZE];
    int n = 0;
    while (v > VARINT_MASK) {
        tmp[n++] = (uint8_t)(v & VARINT_MASK);
        v >>= VARINT_SHIFT;
    }
    tmp[n++] = (uint8_t)v;
    // Reverse into output with continuation bits
    for (int i = 0; i < n; i++) {
        buf[i] = tmp[n - SKIP_ONE - i];
        if (i < n - SKIP_ONE) {
            buf[i] |= VARINT_CONTINUE;
        }
    }
    return n;
}

static int varint_len(int64_t value) {
    uint64_t v = (uint64_t)value;
    int n = VARINT_MIN_LEN;
    while (v > VARINT_MASK) {
        v >>= VARINT_SHIFT;
        n++;
    }
    return n;
}

// SQLite serial type for a TEXT value
static int64_t text_serial_type(int len) {
    return (len * PAIR_LEN) + TEXT_SERIAL_BASE;
}

// SQLite serial type for an integer value
static int64_t int_serial_type(int64_t val) {
    if (val == 0) {
        return SERIAL_CONST_ZERO;
    }
    if (val == SERIAL_INT8) {
        return SERIAL_CONST_ONE;
    }
    if (val >= -INT8_MAX_VAL - SKIP_ONE && val <= INT8_MAX_VAL) {
        return SERIAL_SIZE_INT8;
    }
    if (val >= -INT16_MAX_VAL - SKIP_ONE && val <= INT16_MAX_VAL) {
        return SERIAL_SIZE_INT16;
    }
    if (val >= INT24_MIN_VAL && val <= INT24_MAX_VAL) {
        return SERIAL_SIZE_INT24;
    }
    if (val >= INT32_MIN_VAL && val <= INT32_MAX_VAL) {
        return SERIAL_SIZE_INT32;
    }
    if (val >= INT48_MIN_VAL && val <= INT48_MAX_VAL) {
        return SERIAL_SIZE_INT48;
    }
    return SERIAL_SIZE_INT64;
}

// Bytes needed to store an integer of given serial type
static int int_storage_bytes(int serial_type) {
    switch (serial_type) {
    case 0:
        return 0; // NULL
    case SERIAL_INT8:
        return SERIAL_SIZE_INT8;
    case SERIAL_INT16:
        return SERIAL_SIZE_INT16;
    case SERIAL_INT24:
        return SERIAL_SIZE_INT24;
    case SERIAL_INT32:
        return SERIAL_SIZE_INT32;
    case SERIAL_INT48:
        return SERIAL_SIZE_INT48;
    case SERIAL_INT64:
        return SERIAL_SIZE_INT64;
    case SERIAL_CONST_ZERO: // integer 0
    case SERIAL_CONST_ONE:  // integer 1
    default:
        return 0;
    }
}

// Write integer in big-endian for given byte count
static void put_int_be(uint8_t *buf, int64_t val, int nbytes) {
    for (int i = nbytes - SKIP_ONE; i >= 0; i--) {
        buf[i] = (uint8_t)(val & BYTE_MASK);
        val >>= SHIFT_8;
    }
}

// Write a 2-byte big-endian value
static void put_u16(uint8_t *buf, uint16_t val) {
    buf[0] = (uint8_t)(val >> SHIFT_8);
    buf[SKIP_ONE] = (uint8_t)(val & BYTE_MASK);
}

// Write a 4-byte big-endian value
static void put_u32(uint8_t *buf, uint32_t val) {
    buf[0] = (uint8_t)(val >> SHIFT_24);
    buf[SKIP_ONE] = (uint8_t)(val >> SHIFT_16);
    buf[PAIR_LEN] = (uint8_t)(val >> SHIFT_8);
    buf[SERIAL_SIZE_INT24] = (uint8_t)(val & BYTE_MASK);
}

// --- Dynamic buffer ---

typedef struct {
    uint8_t *data;
    int len;
    int cap;
} DynBuf;

static void dynbuf_init(DynBuf *b) {
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

static bool dynbuf_ensure(DynBuf *b, int needed) {
    if (b->len + needed <= b->cap) {
        return true;
    }
    int newcap = b->cap == 0 ? INITIAL_PAGE_CAP : b->cap;
    while (newcap < b->len + needed) {
        newcap *= GROWTH_FACTOR;
    }
    uint8_t *p = (uint8_t *)realloc(b->data, newcap);
    if (!p) {
        (void)fprintf(stderr, "ctx_write_db: dynbuf realloc failed size=%d\n", newcap);
        return false;
    }
    b->data = p;
    b->cap = newcap;
    return true;
}

static bool dynbuf_append(DynBuf *b, const void *data, int len) {
    if (len <= 0) {
        return true;
    }
    if (!data) {
        return false;
    }
    if (!dynbuf_ensure(b, len)) {
        return false;
    }
    memcpy(b->data + b->len, data, len);
    b->len += len;
    return true;
}

static void dynbuf_free(DynBuf *b) {
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
}

// --- Record builder ---
// Builds a SQLite record: header (header_len varint + serial types) + body (values)

typedef struct {
    DynBuf header; // serial type varints
    DynBuf body;   // column values
} RecordBuilder;

static void rec_init(RecordBuilder *r) {
    dynbuf_init(&r->header);
    dynbuf_init(&r->body);
}

static void rec_free(RecordBuilder *r) {
    dynbuf_free(&r->header);
    dynbuf_free(&r->body);
}

static void rec_add_null(RecordBuilder *r) {
    uint8_t v[SKIP_ONE] = {0};
    dynbuf_append(&r->header, v, SKIP_ONE);
}

static void rec_add_int(RecordBuilder *r, int64_t val) {
    int64_t st = int_serial_type(val);
    uint8_t vbuf[VARINT_MAX_BYTES];
    int vlen = put_varint(vbuf, st);
    dynbuf_append(&r->header, vbuf, vlen);

    int nbytes = int_storage_bytes((int)st);
    if (nbytes > 0) {
        uint8_t ibuf[INT64_BYTES];
        put_int_be(ibuf, val, nbytes);
        dynbuf_append(&r->body, ibuf, nbytes);
    }
}

static void rec_add_text(RecordBuilder *r, const char *s) {
    int slen = s ? (int)strlen(s) : 0;
    int64_t st = text_serial_type(slen);
    uint8_t vbuf[VARINT_MAX_BYTES];
    int vlen = put_varint(vbuf, st);
    dynbuf_append(&r->header, vbuf, vlen);
    if (slen > 0) {
        dynbuf_append(&r->body, s, slen);
    }
}

static void rec_add_blob(RecordBuilder *r, const uint8_t *data, int len) {
    int64_t st = len > 0 ? ((int64_t)len * BLOB_SERIAL_MUL) + BLOB_SERIAL_BASE : 0;
    uint8_t vbuf[VARINT_MAX_BYTES];
    int vlen = put_varint(vbuf, st);
    dynbuf_append(&r->header, vbuf, vlen);
    if (len > 0 && data) {
        dynbuf_append(&r->body, data, len);
    }
}

// Finalize: returns the complete record bytes (header_len + header + body).
// Caller must free the returned buffer.
static uint8_t *rec_finalize(RecordBuilder *r, int *out_len) {
    *out_len = 0;
    int header_content_len = r->header.len;
    int header_len_varint_len = varint_len(header_content_len + varint_len(header_content_len));
    // The header size varint includes itself, so we may need to iterate
    int total_header = header_len_varint_len + header_content_len;
    // Check if the header_len varint changes size when it includes itself
    int recalc = varint_len(total_header);
    if (recalc != header_len_varint_len) {
        header_len_varint_len = recalc;
        total_header = header_len_varint_len + header_content_len;
    }

    int total = total_header + r->body.len;
    uint8_t *buf = (uint8_t *)malloc(total);
    if (!buf) {
        return NULL;
    }
    int pos = put_varint(buf, total_header);
    memcpy(buf + pos, r->header.data, header_content_len);
    pos += header_content_len;
    memcpy(buf + pos, r->body.data, r->body.len);
    *out_len = total;
    return buf;
}

// --- Page builder ---
// Accumulates cells (records) into B-tree leaf pages.

typedef struct {
    uint32_t page_num; // page number of this page (1-based)
    int64_t max_key;   // max rowid on this page (table B-trees)
    uint8_t *sep_cell; // separator cell content for index interior pages (owned, NULL for table)
    int sep_cell_len;
} PageRef;

typedef struct {
    FILE *fp;
    uint32_t next_page; // next page number to allocate
    int page1_offset;   // 100 for page 1, 0 for others
    bool is_index;      // true for index B-trees

    // Current leaf page being built
    uint8_t page[CTX_PAGE_SIZE];
    int cell_count;
    int content_offset; // where cell content starts (grows down from page end)
    int ptr_offset;     // where cell pointers are written (grows up from header)

    // Completed leaf pages for building interior nodes
    PageRef *leaves;
    int leaf_count;
    int leaf_cap;
} PageBuilder;

static void pb_init(PageBuilder *pb, FILE *fp, uint32_t start_page, bool is_index) {
    pb->fp = fp;
    pb->next_page = start_page;
    pb->is_index = is_index;
    pb->cell_count = 0;
    pb->content_offset = CTX_PAGE_SIZE;
    pb->page1_offset = (start_page == SKIP_ONE) ? SQLITE_HEADER_SIZE : 0;
    // Header: flag(1) + freeblock(2) + cell_count(2) + content_start(2) + fragmented(1) = 8
    pb->ptr_offset = pb->page1_offset + BTREE_HEADER_SIZE;
    memset(pb->page, 0, CTX_PAGE_SIZE);
    pb->leaves = NULL;
    pb->leaf_count = 0;
    pb->leaf_cap = 0;
}

static void pb_free(PageBuilder *pb) {
    if (pb->leaves) {
        for (int i = 0; i < pb->leaf_count; i++) {
            free(pb->leaves[i].sep_cell);
        }
        free(pb->leaves);
    }
}

// Flush current leaf page to file
static void pb_flush_leaf(PageBuilder *pb) {
    if (pb->cell_count == 0) {
        return;
    }

    int hdr = pb->page1_offset;
    // Write leaf page header
    pb->page[hdr + 0] = pb->is_index ? BTREE_LEAF_INDEX : BTREE_LEAF_TABLE; // leaf flag
    put_u16(pb->page + hdr + HDR_FREEBLOCK_OFF, 0);                         // first freeblock
    put_u16(pb->page + hdr + HDR_CELLCOUNT_OFF, (uint16_t)pb->cell_count);
    put_u16(pb->page + hdr + HDR_CONTENT_OFF, (uint16_t)pb->content_offset);
    pb->page[hdr + HDR_FRAGBYTES_OFF] = 0; // fragmented free bytes

    // Write page to file. Skip the pending byte page (SQLite reserved).
    pb->next_page = ctx_skip_pending_byte(pb->next_page);
    uint32_t page_num = pb->next_page;
    long offset = (long)(page_num - SKIP_ONE) * CTX_PAGE_SIZE;
    (void)fseek(pb->fp, offset, SEEK_SET);
    (void)fwrite(pb->page, SKIP_ONE, CTX_PAGE_SIZE, pb->fp);

    // Record this leaf for interior page building
    if (pb->leaf_count >= pb->leaf_cap) {
        int old_cap = pb->leaf_cap;
        pb->leaf_cap = old_cap == 0 ? INITIAL_LEAF_CAP : old_cap * GROWTH_FACTOR;
        void *tmp = realloc(pb->leaves, (size_t)pb->leaf_cap * sizeof(PageRef));
        if (!tmp) {
            free(pb->leaves);
            pb->leaves = NULL;
            return;
        }
        pb->leaves = (PageRef *)tmp;
        /* Zero-init new slots */
        memset(&pb->leaves[old_cap], 0, ((size_t)pb->leaf_cap - (size_t)old_cap) * sizeof(PageRef));
    }
    pb->leaves[pb->leaf_count].page_num = page_num;
    // max_key is set by caller before flush
    pb->leaf_count++;

    // Reset for next page
    pb->next_page++;
    pb->cell_count = 0;
    pb->content_offset = CTX_PAGE_SIZE;
    pb->page1_offset = 0;               // only page 1 has the 100-byte header
    pb->ptr_offset = BTREE_HEADER_SIZE; // standard B-tree header size for non-page-1
    memset(pb->page, 0, CTX_PAGE_SIZE);
}

// Check if a cell of given size fits in the current page
static bool pb_cell_fits(PageBuilder *pb, int cell_len) {
    // Cell pointer (2 bytes) + cell content
    int available = pb->content_offset - pb->ptr_offset - CELL_PTR_SIZE;
    return cell_len <= available;
}

// Add a cell to the current leaf page.
// For table leaves: varint(payload_len) + varint(rowid) + payload
// For index leaves: varint(payload_len) + payload
static void pb_add_cell(PageBuilder *pb, const uint8_t *cell, int cell_len) {
    // Write cell content (grows down)
    pb->content_offset -= cell_len;
    memcpy(pb->page + pb->content_offset, cell, cell_len);

    // Write cell pointer (grows up)
    put_u16(pb->page + pb->ptr_offset, (uint16_t)pb->content_offset);
    pb->ptr_offset += CELL_PTR_SIZE;
    pb->cell_count++;
}

// Build interior pages from child page references.
// Returns the root page number.
//
// SQLite interior page structure:
//   - Header has right-child pointer (the last child page)
//   - Each cell contains: child_page(4) + key
//   - For N children, there are N-1 cells (children[0..N-2] get cells,
//     children[N-1] becomes the right-child in the header)
//   - Cell[j] = {left_child: children[j].page, key: children[j].max_key/sep_cell}
//   - Lookup: X ≤ K0 → cell[0].left_child, K0 < X ≤ K1 → cell[1].left_child, etc.
//   - Table keys: varint(rowid)
//   - Index keys: varint(payload_len) + payload (full index record)
// Build an interior cell for a child PageRef. Returns cell length.
// For table B-trees: child_page(4) + varint(rowid).
// For index B-trees: child_page(4) + separator_cell.
// cell_buf must be at least 20 bytes for table cells.
// For index cells, returns malloc'd data via *out_heap (caller frees).
static int build_interior_cell(const PageRef *child, bool is_index, uint8_t *cell_buf,
                               uint8_t **out_heap) {
    *out_heap = NULL;
    if (!is_index) {
        put_u32(cell_buf, child->page_num);
        return BTREE_PTR_SIZE + put_varint(cell_buf + BTREE_PTR_SIZE, child->max_key);
    }
    int clen = BTREE_PTR_SIZE + child->sep_cell_len;
    uint8_t *data = (uint8_t *)malloc(clen);
    put_u32(data, child->page_num);
    memcpy(data + 4, child->sep_cell, child->sep_cell_len);
    *out_heap = data;
    return clen;
}

// Write a completed interior page to disk and record it as a parent.
// Returns updated parent_count, or -1 on allocation failure.
static int write_interior_page(PageBuilder *pb, uint8_t *page, int cell_count, int content_offset,
                               uint32_t right_child_page, const PageRef *children,
                               int right_child_idx, bool is_index, PageRef **parents,
                               int parent_count, int *parent_cap) {
    pb->next_page = ctx_skip_pending_byte(pb->next_page);
    uint32_t pnum = pb->next_page++;
    page[0] = is_index ? INTERIOR_INDEX_FLAG : INTERIOR_TABLE_FLAG;
    put_u16(page + HDR_FREEBLOCK_OFF, 0);
    put_u16(page + HDR_CELLCOUNT_OFF, (uint16_t)cell_count);
    put_u16(page + HDR_CONTENT_OFF, (uint16_t)content_offset);
    page[HDR_FRAGBYTES_OFF] = 0;
    put_u32(page + HDR_RIGHTCHILD_OFF, right_child_page);

    (void)fseek(pb->fp, (long)(pnum - SKIP_ONE) * CTX_PAGE_SIZE, SEEK_SET);
    (void)fwrite(page, SKIP_ONE, CTX_PAGE_SIZE, pb->fp);

    if (parent_count >= *parent_cap) {
        int old_pcap = *parent_cap;
        *parent_cap = old_pcap == 0 ? INITIAL_PARENT_CAP : old_pcap * GROWTH_FACTOR;
        PageRef *tmp = (PageRef *)realloc(*parents, *parent_cap * sizeof(PageRef));
        if (!tmp) {
            free(*parents);
            *parents = NULL;
            return CTX_NOT_FOUND;
        }
        *parents = tmp;
        memset(&(*parents)[old_pcap], 0,
               ((size_t)*parent_cap - (size_t)old_pcap) * sizeof(PageRef));
    }
    (*parents)[parent_count].page_num = pnum;
    (*parents)[parent_count].max_key = children[right_child_idx].max_key;
    if (is_index && children[right_child_idx].sep_cell) {
        int slen = children[right_child_idx].sep_cell_len;
        (*parents)[parent_count].sep_cell = (uint8_t *)malloc(slen);
        memcpy((*parents)[parent_count].sep_cell, children[right_child_idx].sep_cell, slen);
        (*parents)[parent_count].sep_cell_len = slen;
    } else {
        (*parents)[parent_count].sep_cell = NULL;
        (*parents)[parent_count].sep_cell_len = 0;
    }
    return parent_count + SKIP_ONE;
}

// Free a PageRef array (sep_cell allocations), unless it's the original leaves.
static void free_children(PageRef *children, int child_count, const PageRef *leaves) {
    if (children != leaves) {
        for (int j = 0; j < child_count; j++) {
            free(children[j].sep_cell);
        }
        free(children);
    }
}

// Fill an interior page with cells from children[*idx..child_count-2].
// Updates cell_count, content_offset, ptr_offset, and *idx.
static void fill_interior_page(uint8_t *page, const PageRef *children, int child_count,
                               bool is_index, int *idx, int *cell_count, int *content_offset,
                               int *ptr_offset) {
    while (*idx < child_count - SKIP_ONE) {
        uint8_t tbuf[INTERIOR_CELL_BUF];
        uint8_t *heap_cell = NULL;
        int clen = build_interior_cell(&children[*idx], is_index, tbuf, &heap_cell);
        uint8_t *cell_data = heap_cell ? heap_cell : tbuf;

        int available = *content_offset - *ptr_offset - CELL_PTR_SIZE;
        if (clen > available && *cell_count > 0) {
            free(heap_cell);
            break;
        }

        *content_offset -= clen;
        memcpy(page + *content_offset, cell_data, clen);
        put_u16(page + *ptr_offset, (uint16_t)*content_offset);
        *ptr_offset += CELL_PTR_SIZE;
        (*cell_count)++;
        free(heap_cell);
        (*idx)++;
    }
}

static uint32_t pb_build_interior(PageBuilder *pb, bool is_index) {
    if (!pb->leaves) {
        return 0;
    }
    if (pb->leaf_count <= SKIP_ONE) {
        return pb->leaves[0].page_num;
    }

    PageRef *children = pb->leaves;
    int child_count = pb->leaf_count;

    while (child_count > SKIP_ONE && children) {
        PageRef *parents = NULL;
        int parent_count = 0;
        int parent_cap = 0;

        int i = 0;
        while (i < child_count) {
            uint8_t page[CTX_PAGE_SIZE];
            memset(page, 0, CTX_PAGE_SIZE);
            int cell_count = 0;
            int content_offset = CTX_PAGE_SIZE;
            int ptr_offset = BTREE_INTERIOR_HDR;

            fill_interior_page(page, children, child_count, is_index, &i, &cell_count,
                               &content_offset, &ptr_offset);

            int right_child_idx = (i < child_count - SKIP_ONE) ? i : child_count - SKIP_ONE;
            uint32_t right_child_page = 0;
            if (right_child_idx >= 0 && right_child_idx < child_count) {
                right_child_page = children[right_child_idx].page_num;
            }
            if (i < child_count - SKIP_ONE) {
                i++;
            } else {
                i = child_count;
            }

            parent_count = write_interior_page(pb, page, cell_count, content_offset,
                                               right_child_page, children, right_child_idx,
                                               is_index, &parents, parent_count, &parent_cap);
            if (parent_count < 0) {
                break;
            }
        }

        free_children(children, child_count, pb->leaves);
        children = parents;
        child_count = parent_count;
    }

    uint32_t root = children ? children[0].page_num : 0;
    free_children(children, child_count, pb->leaves);
    return root;
}

// --- ID formatting helpers (Cortex schema) ---

/* Format an integer counter as 'ctx-<int>' for nodes. buf must be >=32 bytes. */
static void format_node_id(char *buf, size_t buflen, int64_t counter) {
    snprintf(buf, buflen, "ctx-%lld", (long long)counter);
}

/* Format an integer counter as 'ctx-e<int>' for edges. buf must be >=32 bytes. */
static void format_edge_id(char *buf, size_t buflen, int64_t counter) {
    snprintf(buf, buflen, "ctx-e%lld", (long long)counter);
}

/* Heap-allocated lowercase copy. Returns NULL on alloc failure or NULL input. */
static char *str_to_lower(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s);
    char *out = (char *)malloc(n + SKIP_ONE);
    if (!out) return NULL;
    for (size_t i = 0; i < n; i++) out[i] = (char)tolower((unsigned char)s[i]);
    out[n] = '\0';
    return out;
}

// --- Table record builders ---

// Build a nodes table record matching Cortex's nodes schema (12 columns):
//   id TEXT PK, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT,
//   data TEXT, tier TEXT, created_at TEXT, updated_at TEXT,
//   start_line INTEGER, end_line INTEGER, project TEXT
static uint8_t *build_node_record(const CtxDumpNode *n, const char *indexed_at, int *out_len) {
    RecordBuilder r;
    rec_init(&r);

    char id_buf[32];
    format_node_id(id_buf, sizeof(id_buf), n->id);
    char *kind = str_to_lower(n->label ? n->label : "");

    rec_add_text(&r, id_buf);
    rec_add_text(&r, kind ? kind : "");
    rec_add_text(&r, n->name ? n->name : "");
    rec_add_text(&r, n->qualified_name ? n->qualified_name : "");
    rec_add_text(&r, n->file_path ? n->file_path : "");
    rec_add_text(&r, n->properties ? n->properties : "{}"); /* properties → data */
    rec_add_text(&r, "shared");                              /* tier */
    rec_add_text(&r, indexed_at ? indexed_at : "");         /* created_at */
    rec_add_text(&r, indexed_at ? indexed_at : "");         /* updated_at */
    rec_add_int(&r, n->start_line);
    rec_add_int(&r, n->end_line);
    rec_add_text(&r, n->project ? n->project : "");

    free(kind);
    uint8_t *data = rec_finalize(&r, out_len);
    rec_free(&r);
    return data;
}

// Build an edges table record matching Cortex's edges schema (7 columns):
//   id TEXT PK, source_id TEXT, target_id TEXT, relation TEXT,
//   data TEXT, created_at TEXT, project TEXT
static uint8_t *build_edge_record(const CtxDumpEdge *e, const char *indexed_at, int *out_len) {
    RecordBuilder r;
    rec_init(&r);

    char id_buf[32], src_buf[32], tgt_buf[32];
    format_edge_id(id_buf, sizeof(id_buf), e->id);
    format_node_id(src_buf, sizeof(src_buf), e->source_id);
    format_node_id(tgt_buf, sizeof(tgt_buf), e->target_id);

    rec_add_text(&r, id_buf);
    rec_add_text(&r, src_buf);
    rec_add_text(&r, tgt_buf);
    rec_add_text(&r, e->type ? e->type : "");               /* type → relation */
    rec_add_text(&r, e->properties ? e->properties : "{}"); /* properties → data */
    rec_add_text(&r, indexed_at ? indexed_at : "");         /* created_at */
    rec_add_text(&r, e->project ? e->project : "");

    uint8_t *data = rec_finalize(&r, out_len);
    rec_free(&r);
    return data;
}

// Build a node_vectors table record: (node_id, project, vector)
// Includes node_id in the record body (same pattern as build_node_record).
static uint8_t *build_vector_record(const CtxDumpVector *v, int *out_len) {
    RecordBuilder r;
    rec_init(&r);

    rec_add_int(&r, v->node_id);
    rec_add_text(&r, v->project);
    rec_add_blob(&r, v->vector, v->vector_len);

    uint8_t *data = rec_finalize(&r, out_len);
    rec_free(&r);
    return data;
}

// Build a token_vectors table record: (id, project, token, vector, idf)
static uint8_t *build_token_vec_record(const CtxDumpTokenVec *tv, int *out_len) {
    RecordBuilder r;
    rec_init(&r);

    rec_add_int(&r, tv->id);
    rec_add_text(&r, tv->project);
    rec_add_text(&r, tv->token);
    rec_add_blob(&r, tv->vector, tv->vector_len);
    /* Store IDF as integer × 1000 for fixed-point (avoid float in record) */
    enum { IDF_FIXED_POINT_SCALE = 1000 };
    rec_add_int(&r, (int64_t)(tv->idf * IDF_FIXED_POINT_SCALE));

    uint8_t *data = rec_finalize(&r, out_len);
    rec_free(&r);
    return data;
}

// Build a projects table record: (name, indexed_at, root_path)
static uint8_t *build_project_record(const char *name, const char *indexed_at,
                                     const char *root_path, int *out_len) {
    RecordBuilder r;
    rec_init(&r);

    rec_add_text(&r, name);
    rec_add_text(&r, indexed_at);
    rec_add_text(&r, root_path);

    uint8_t *data = rec_finalize(&r, out_len);
    rec_free(&r);
    return data;
}

// --- Table cell builder ---
// Table leaf cell: varint(payload_len) + varint(rowid) + payload

static uint8_t *build_table_cell(int64_t rowid, const uint8_t *payload, int payload_len,
                                 int *out_cell_len) {
    int rl = varint_len(payload_len);
    int kl = varint_len(rowid);
    int total = rl + kl + payload_len;
    uint8_t *cell = (uint8_t *)malloc(total);
    if (!cell) {
        return NULL;
    }
    int pos = 0;
    pos += put_varint(cell + pos, payload_len);
    pos += put_varint(cell + pos, rowid);
    memcpy(cell + pos, payload, payload_len);
    *out_cell_len = pos + payload_len;
    return cell;
}

// --- Index record builders ---

// Build an index entry for a 2-column TEXT index (project, col) + rowid.
// Index records: varint(payload_len) + payload(record of indexed cols + rowid)
static uint8_t *build_index_entry_2text_rowid(const char *col1, const char *col2, int64_t rowid,
                                              int *out_len) {
    // Build the record portion: (col1, col2, rowid)
    RecordBuilder r;
    rec_init(&r);
    rec_add_text(&r, col1);
    rec_add_text(&r, col2);
    rec_add_int(&r, rowid);
    int payload_len = 0;
    uint8_t *payload = rec_finalize(&r, &payload_len);
    rec_free(&r);
    if (!payload) {
        *out_len = 0;
        return NULL;
    }

    // Index cell: varint(payload_len) + payload
    int vl = varint_len(payload_len);
    int total = vl + payload_len;
    uint8_t *cell = (uint8_t *)malloc(total);
    if (!cell) {
        free(payload);
        *out_len = 0;
        return NULL;
    }
    int pos = put_varint(cell, payload_len);
    memcpy(cell + pos, payload, payload_len);
    free(payload);
    *out_len = total;
    return cell;
}

// --- Write a table B-tree from records ---

// Ensure leaves array has capacity for one more entry.
// Returns false on allocation failure.
static bool pb_ensure_leaf_cap(PageBuilder *pb) {
    if (pb->leaf_count < pb->leaf_cap) {
        return true;
    }
    pb->leaf_cap = pb->leaf_cap == 0 ? INITIAL_LEAF_CAP : pb->leaf_cap * GROWTH_FACTOR;
    void *tmp = realloc(pb->leaves, (size_t)pb->leaf_cap * sizeof(PageRef));
    if (!tmp) {
        free(pb->leaves);
        pb->leaves = NULL;
        return false;
    }
    pb->leaves = (PageRef *)tmp;
    return true;
}

// Add a table cell to the PageBuilder, flushing leaf pages as needed.
static void pb_add_table_cell_with_flush(PageBuilder *pb, int64_t rowid, const uint8_t *payload,
                                         int payload_len, int64_t prev_rowid) {
    int cell_len = 0;
    uint8_t *cell = build_table_cell(rowid, payload, payload_len, &cell_len);
    if (!cell) {
        return;
    }

    if (!pb_cell_fits(pb, cell_len) && pb->cell_count > 0) {
        if (!pb_ensure_leaf_cap(pb)) {
            free(cell);
            return;
        }
        pb->leaves[pb->leaf_count].max_key = prev_rowid;
        pb->leaves[pb->leaf_count].sep_cell = NULL;
        pb->leaves[pb->leaf_count].sep_cell_len = 0;
        pb_flush_leaf(pb);
    }

    pb_add_cell(pb, cell, cell_len);
    free(cell);
}

// Finalize a table PageBuilder: flush last leaf and build interior pages.
static uint32_t pb_finalize_table(PageBuilder *pb, uint32_t *next_page, int64_t last_rowid) {
    if (pb->cell_count > 0) {
        pb_ensure_leaf_cap(pb);
        if (!pb->leaves) {
            pb_free(pb);
            return 0;
        }
        pb->leaves[pb->leaf_count].max_key = last_rowid;
        pb->leaves[pb->leaf_count].sep_cell = NULL;
        pb->leaves[pb->leaf_count].sep_cell_len = 0;
        pb_flush_leaf(pb);
    }

    *next_page = pb->next_page;
    uint32_t root;
    if (pb->leaf_count == SKIP_ONE) {
        root = pb->leaves[0].page_num;
    } else if (pb->leaf_count > SKIP_ONE) {
        root = pb_build_interior(pb, false);
        *next_page = pb->next_page;
    } else {
        root = 0; // shouldn't happen when count > 0
    }
    pb_free(pb);
    return root;
}

// Write leaf pages for a table, returns root page.
// rowids must be sequential starting from 1 (or single-row PK text).
static uint32_t write_table_btree(FILE *fp, uint32_t *next_page, const uint8_t **records,
                                  const int *record_lens, const int64_t *rowids, int count,
                                  bool first_is_page1) {
    if (count == 0) {
        // Empty table: write a single empty leaf page
        *next_page = ctx_skip_pending_byte(*next_page);
        uint32_t pnum = (*next_page)++;
        uint8_t page[CTX_PAGE_SIZE];
        memset(page, 0, CTX_PAGE_SIZE);
        int hdr = first_is_page1 ? SQLITE_HEADER_SIZE : 0;
        page[hdr] = BTREE_LEAF_TABLE;                                   // leaf table
        put_u16(page + hdr + HDR_FREEBLOCK_OFF, 0);                     // no freeblocks
        put_u16(page + hdr + HDR_CELLCOUNT_OFF, 0);                     // 0 cells
        put_u16(page + hdr + HDR_CONTENT_OFF, (uint16_t)CTX_PAGE_SIZE); // content at end of page
        page[hdr + HDR_FRAGBYTES_OFF] = 0;                              // 0 fragmented bytes
        (void)fseek(fp, (long)(pnum - SKIP_ONE) * CTX_PAGE_SIZE, SEEK_SET);
        (void)fwrite(page, SKIP_ONE, CTX_PAGE_SIZE, fp);
        return pnum;
    }

    PageBuilder pb;
    pb_init(&pb, fp, *next_page, false);
    pb.page1_offset = first_is_page1 ? SQLITE_HEADER_SIZE : 0;
    pb.ptr_offset = pb.page1_offset + BTREE_HEADER_SIZE;

    for (int i = 0; i < count; i++) {
        pb_add_table_cell_with_flush(&pb, rowids[i], records[i], record_lens[i],
                                     i > 0 ? rowids[i - SKIP_ONE] : 0);
    }

    return pb_finalize_table(&pb, next_page, rowids[count - SKIP_ONE]);
}

// Promote the last cell from current page to separator, un-add it, and flush.
static bool pb_promote_and_flush(PageBuilder *pb, uint8_t **cells, int *cell_lens, int prev_idx) {
    if (!pb_ensure_leaf_cap(pb)) {
        return false;
    }
    pb->leaves[pb->leaf_count].max_key = 0;
    pb->leaves[pb->leaf_count].sep_cell = (uint8_t *)malloc(cell_lens[prev_idx]);
    memcpy(pb->leaves[pb->leaf_count].sep_cell, cells[prev_idx], cell_lens[prev_idx]);
    pb->leaves[pb->leaf_count].sep_cell_len = cell_lens[prev_idx];

    // Un-add the last cell — it's promoted to the interior separator.
    // SQLite index B-tree interior cells are counted by integrity_check,
    // so this cell exists in the interior page instead of the leaf.
    pb->cell_count--;
    pb->content_offset += cell_lens[prev_idx];
    pb->ptr_offset -= CELL_PTR_SIZE;

    pb_flush_leaf(pb);
    return true;
}

// Write an empty index leaf page.
static uint32_t write_empty_index_leaf(FILE *fp, uint32_t *next_page) {
    *next_page = ctx_skip_pending_byte(*next_page);
    uint32_t pnum = (*next_page)++;
    uint8_t page[CTX_PAGE_SIZE];
    memset(page, 0, CTX_PAGE_SIZE);
    page[0] = NEWLINE_BYTE;
    put_u16(page + HDR_FREEBLOCK_OFF, 0);
    put_u16(page + HDR_CELLCOUNT_OFF, 0);
    put_u16(page + HDR_CONTENT_OFF, (uint16_t)CTX_PAGE_SIZE);
    page[HDR_FRAGBYTES_OFF] = 0;
    (void)fseek(fp, (long)(pnum - SKIP_ONE) * CTX_PAGE_SIZE, SEEK_SET);
    (void)fwrite(page, SKIP_ONE, CTX_PAGE_SIZE, fp);
    return pnum;
}

// Write leaf pages for an index, returns root page.
static uint32_t write_index_btree(FILE *fp, uint32_t *next_page, uint8_t **cells, int *cell_lens,
                                  int count) {
    if (count == 0) {
        return write_empty_index_leaf(fp, next_page);
    }

    PageBuilder pb;
    pb_init(&pb, fp, *next_page, true);

    for (int i = 0; i < count; i++) {
        if (!pb_cell_fits(&pb, cell_lens[i]) && pb.cell_count > 0) {
            if (!pb_promote_and_flush(&pb, cells, cell_lens, i - SKIP_ONE)) {
                return 0;
            }
        }
        pb_add_cell(&pb, cells[i], cell_lens[i]);
    }

    if (pb.cell_count > 0) {
        if (!pb_ensure_leaf_cap(&pb)) {
            return 0;
        }
        pb.leaves[pb.leaf_count].max_key = 0;
        int last = count - SKIP_ONE;
        pb.leaves[pb.leaf_count].sep_cell = (uint8_t *)malloc(cell_lens[last]);
        memcpy(pb.leaves[pb.leaf_count].sep_cell, cells[last], cell_lens[last]);
        pb.leaves[pb.leaf_count].sep_cell_len = cell_lens[last];
        pb_flush_leaf(&pb);
    }

    *next_page = pb.next_page;

    uint32_t root;
    if (!pb.leaves) {
        root = 0;
    } else if (pb.leaf_count == SKIP_ONE) {
        root = pb.leaves[0].page_num;
    } else {
        root = pb_build_interior(&pb, true);
        *next_page = pb.next_page;
    }

    pb_free(&pb);
    return root;
}

// --- sqlite_master entries ---

typedef struct {
    const char *type;     // "table" or "index"
    const char *name;     // table/index name
    const char *tbl_name; // table name
    uint32_t rootpage;    // root page number
    const char *sql;      // CREATE statement
} MasterEntry;

static uint8_t *build_master_record(const MasterEntry *e, int *out_len) {
    RecordBuilder r;
    rec_init(&r);
    rec_add_text(&r, e->type);
    rec_add_text(&r, e->name);
    rec_add_text(&r, e->tbl_name);
    rec_add_int(&r, (int64_t)e->rootpage);
    if (e->sql) {
        rec_add_text(&r, e->sql);
    } else {
        rec_add_null(&r);
    }
    uint8_t *data = rec_finalize(&r, out_len);
    rec_free(&r);
    return data;
}

// --- qsort comparators for index sorting ---
// Single-threaded writer: static context is safe.

static const CtxDumpNode *g_sort_nodes;
static const CtxDumpEdge *g_sort_edges;

static inline int cmp_i64(int64_t a, int64_t b) {
    return (a > b) - (a < b);
}

static inline const char *safe_str(const char *s) {
    return s ? s : "";
}

// Allocate permutation array [0, 1, ..., n-1], sort with comparator.
// Returns NULL on allocation failure.
static int *make_sorted_perm(int n, int (*cmp)(const void *, const void *)) {
    int *perm = (int *)malloc(n * sizeof(int));
    if (!perm) {
        (void)fprintf(stderr, "ctx_write_db: perm malloc failed n=%d size=%zu\n", n,
                      (size_t)n * sizeof(int));
        return NULL;
    }
    for (int i = 0; i < n; i++) {
        perm[i] = i;
    }
    qsort(perm, n, sizeof(int), cmp);
    return perm;
}

// --- Node index comparators (Cortex schema) ---

// idx_nodes_kind: single-column TEXT index on kind (== LOWER(label))
static int cmp_node_by_label(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_nodes[ia].label), safe_str(g_sort_nodes[ib].label));
    if (c) return c;
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// idx_nodes_name: single-column TEXT index on name
static int cmp_node_by_name(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_nodes[ia].name), safe_str(g_sort_nodes[ib].name));
    if (c) return c;
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// idx_nodes_qualified_name: single-column TEXT index on qualified_name
static int cmp_node_by_qn(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_nodes[ia].qualified_name),
                   safe_str(g_sort_nodes[ib].qualified_name));
    if (c) return c;
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// idx_nodes_file_path: single-column TEXT index on file_path
static int cmp_node_by_file(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_nodes[ia].file_path), safe_str(g_sort_nodes[ib].file_path));
    if (c) return c;
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// idx_nodes_tier: all rows have tier='shared' so sort is just by rowid
static int cmp_node_by_tier(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    /* tier is constant "shared" for all rows; break ties by rowid */
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// idx_nodes_kind_project: 2-column (kind TEXT, project TEXT)
static int cmp_node_by_kind_project(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_nodes[ia].label), safe_str(g_sort_nodes[ib].label));
    if (c) return c;
    c = strcmp(safe_str(g_sort_nodes[ia].project), safe_str(g_sort_nodes[ib].project));
    if (c) return c;
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// idx_nodes_kind_file: 2-column (kind TEXT, file_path TEXT)
static int cmp_node_by_kind_file(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_nodes[ia].label), safe_str(g_sort_nodes[ib].label));
    if (c) return c;
    c = strcmp(safe_str(g_sort_nodes[ia].file_path), safe_str(g_sort_nodes[ib].file_path));
    if (c) return c;
    return cmp_i64(g_sort_nodes[ia].id, g_sort_nodes[ib].id);
}

// --- Edge index comparators (Cortex schema) ---

// idx_edges_source: single-column source_id TEXT — sort lexicographically over 'ctx-<int>'
// (numeric int sort doesn't match SQLite BINARY text collation: 'ctx-2' > 'ctx-10').
static int cmp_edge_by_source(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    char buf_a[32], buf_b[32];
    format_node_id(buf_a, sizeof(buf_a), g_sort_edges[ia].source_id);
    format_node_id(buf_b, sizeof(buf_b), g_sort_edges[ib].source_id);
    int c = strcmp(buf_a, buf_b);
    if (c) return c;
    return cmp_i64(g_sort_edges[ia].id, g_sort_edges[ib].id);
}

// idx_edges_target: single-column target_id TEXT (same lexicographic ordering as source).
static int cmp_edge_by_target(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    char buf_a[32], buf_b[32];
    format_node_id(buf_a, sizeof(buf_a), g_sort_edges[ia].target_id);
    format_node_id(buf_b, sizeof(buf_b), g_sort_edges[ib].target_id);
    int c = strcmp(buf_a, buf_b);
    if (c) return c;
    return cmp_i64(g_sort_edges[ia].id, g_sort_edges[ib].id);
}

// idx_edges_relation: single-column relation TEXT (== type)
static int cmp_edge_by_relation(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_edges[ia].type), safe_str(g_sort_edges[ib].type));
    if (c) return c;
    return cmp_i64(g_sort_edges[ia].id, g_sort_edges[ib].id);
}

// idx_edges_project_relation: 2-column (project TEXT, relation TEXT)
static int cmp_edge_by_proj_relation(const void *a, const void *b) {
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    int c = strcmp(safe_str(g_sort_edges[ia].project), safe_str(g_sort_edges[ib].project));
    if (c) return c;
    c = strcmp(safe_str(g_sort_edges[ia].type), safe_str(g_sort_edges[ib].type));
    if (c) return c;
    return cmp_i64(g_sort_edges[ia].id, g_sort_edges[ib].id);
}

// --- Parallel sort support ---

typedef struct {
    int count;
    int (*cmp)(const void *, const void *);
    int *perm; // output: sorted permutation array, caller frees
} SortJob;

static void *sort_worker(void *arg) {
    SortJob *j = (SortJob *)arg;
    j->perm = make_sorted_perm(j->count, j->cmp);
    return NULL;
}

/* Edge index cell builder callback: builds one index cell from an edge. */
typedef uint8_t *(*edge_cell_fn)(const CtxDumpEdge *e, int *out_len);

/* Build a 1-column TEXT index cell: (text_val) + rowid.
 * Used for idx_edges_source (source_id TEXT) and idx_edges_target (target_id TEXT). */
static uint8_t *build_index_entry_1text_rowid(const char *col, int64_t rowid, int *out_len) {
    RecordBuilder r;
    rec_init(&r);
    rec_add_text(&r, col);
    rec_add_int(&r, rowid);
    int payload_len = 0;
    uint8_t *payload = rec_finalize(&r, &payload_len);
    rec_free(&r);
    if (!payload) { *out_len = 0; return NULL; }
    int vl = varint_len(payload_len);
    int total = vl + payload_len;
    uint8_t *cell = (uint8_t *)malloc(total);
    if (!cell) { free(payload); *out_len = 0; return NULL; }
    int pos = put_varint(cell, payload_len);
    memcpy(cell + pos, payload, payload_len);
    free(payload);
    *out_len = total;
    return cell;
}

/* idx_edges_source: (source_id TEXT) + rowid */
static uint8_t *ecell_source(const CtxDumpEdge *e, int *out_len) {
    char src_buf[32];
    format_node_id(src_buf, sizeof(src_buf), e->source_id);
    return build_index_entry_1text_rowid(src_buf, e->id, out_len);
}

/* idx_edges_target: (target_id TEXT) + rowid */
static uint8_t *ecell_target(const CtxDumpEdge *e, int *out_len) {
    char tgt_buf[32];
    format_node_id(tgt_buf, sizeof(tgt_buf), e->target_id);
    return build_index_entry_1text_rowid(tgt_buf, e->id, out_len);
}

/* idx_edges_relation: (relation TEXT) + rowid */
static uint8_t *ecell_relation(const CtxDumpEdge *e, int *out_len) {
    return build_index_entry_1text_rowid(safe_str(e->type), e->id, out_len);
}

/* idx_edges_project_relation: (project TEXT, relation TEXT) + rowid */
static uint8_t *ecell_proj_relation(const CtxDumpEdge *e, int *out_len) {
    return build_index_entry_2text_rowid(safe_str(e->project), safe_str(e->type), e->id, out_len);
}

/* Build an edge index from a pre-sorted permutation using a cell builder callback. */
static uint32_t build_edge_index_sorted(FILE *fp, uint32_t *next_page, CtxDumpEdge *edges,
                                        int edge_count, int *perm, edge_cell_fn cell_fn) {
    if (edge_count <= 0) {
        return write_index_btree(fp, next_page, NULL, NULL, 0);
    }
    if (!perm) {
        return 0;
    }
    uint8_t **idx_cells = (uint8_t **)malloc(edge_count * sizeof(uint8_t *));
    int *idx_lens = (int *)malloc(edge_count * sizeof(int));
    if (!idx_cells || !idx_lens) {
        free(perm);
        free(idx_cells);
        free(idx_lens);
        return 0;
    }
    for (int i = 0; i < edge_count; i++) {
        int si = perm[i];
        idx_cells[i] = cell_fn(&edges[si], &idx_lens[i]);
        if (!idx_cells[i]) {
            for (int j = 0; j < i; j++) {
                free(idx_cells[j]);
            }
            free(idx_cells);
            free(idx_lens);
            free(perm);
            return 0;
        }
    }
    free(perm);
    uint32_t root = write_index_btree(fp, next_page, idx_cells, idx_lens, edge_count);
    for (int i = 0; i < edge_count; i++) {
        free(idx_cells[i]);
    }
    free(idx_cells);
    free(idx_lens);
    return root;
}

/* Node cell builder callback for index building. */
typedef uint8_t *(*node_cell_fn)(const CtxDumpNode *n, int *out_len);

/* idx_nodes_kind: (kind TEXT) + rowid — kind = LOWER(label) */
static uint8_t *ncell_kind(const CtxDumpNode *n, int *out_len) {
    char *kind = str_to_lower(n->label ? n->label : "");
    uint8_t *cell = build_index_entry_1text_rowid(kind ? kind : "", n->id, out_len);
    free(kind);
    return cell;
}

/* idx_nodes_name: (name TEXT) + rowid */
static uint8_t *ncell_name(const CtxDumpNode *n, int *out_len) {
    return build_index_entry_1text_rowid(n->name ? n->name : "", n->id, out_len);
}

/* idx_nodes_qualified_name: (qualified_name TEXT) + rowid */
static uint8_t *ncell_qn(const CtxDumpNode *n, int *out_len) {
    return build_index_entry_1text_rowid(n->qualified_name ? n->qualified_name : "", n->id, out_len);
}

/* idx_nodes_file_path: (file_path TEXT) + rowid */
static uint8_t *ncell_file(const CtxDumpNode *n, int *out_len) {
    return build_index_entry_1text_rowid(n->file_path ? n->file_path : "", n->id, out_len);
}

/* idx_nodes_tier: (tier TEXT) + rowid — tier is always "shared" for code nodes */
static uint8_t *ncell_tier(const CtxDumpNode *n, int *out_len) {
    return build_index_entry_1text_rowid("shared", n->id, out_len);
}

/* idx_nodes_kind_project: (kind TEXT, project TEXT) + rowid */
static uint8_t *ncell_kind_project(const CtxDumpNode *n, int *out_len) {
    char *kind = str_to_lower(n->label ? n->label : "");
    uint8_t *cell =
        build_index_entry_2text_rowid(kind ? kind : "", n->project ? n->project : "", n->id, out_len);
    free(kind);
    return cell;
}

/* idx_nodes_kind_file: (kind TEXT, file_path TEXT) + rowid */
static uint8_t *ncell_kind_file(const CtxDumpNode *n, int *out_len) {
    char *kind = str_to_lower(n->label ? n->label : "");
    uint8_t *cell = build_index_entry_2text_rowid(kind ? kind : "",
                                                  n->file_path ? n->file_path : "", n->id, out_len);
    free(kind);
    return cell;
}

/* Build a node index from a pre-sorted permutation using a cell builder callback.
 * Returns root page or 0. */
static uint32_t build_node_index_sorted(FILE *fp, uint32_t *next_page, CtxDumpNode *nodes,
                                        int node_count, int *perm, node_cell_fn cell_fn) {
    if (node_count <= 0) {
        return write_index_btree(fp, next_page, NULL, NULL, 0);
    }
    if (!perm) {
        return 0;
    }
    uint8_t **idx_cells = (uint8_t **)malloc(node_count * sizeof(uint8_t *));
    int *idx_lens = (int *)malloc(node_count * sizeof(int));
    if (!idx_cells || !idx_lens) {
        free(perm);
        free(idx_cells);
        free(idx_lens);
        return 0;
    }
    for (int i = 0; i < node_count; i++) {
        int si = perm[i];
        idx_cells[i] = cell_fn(&nodes[si], &idx_lens[i]);
        if (!idx_cells[i]) {
            for (int j = 0; j < i; j++) {
                free(idx_cells[j]);
            }
            free(idx_cells);
            free(idx_lens);
            free(perm);
            return 0;
        }
    }
    free(perm);
    uint32_t root = write_index_btree(fp, next_page, idx_cells, idx_lens, node_count);
    for (int i = 0; i < node_count; i++) {
        free(idx_cells[i]);
    }
    free(idx_cells);
    free(idx_lens);
    return root;
}

// --- Main entry point ---

/* Write context passed to sub-phases of ctx_write_db. */
typedef struct {
    FILE *fp;
    uint32_t next_page;
    const char *project;
    const char *root_path;
    const char *indexed_at;
    CtxDumpNode *nodes;
    int node_count;
    CtxDumpEdge *edges;
    int edge_count;
    CtxDumpVector *vectors;
    int vector_count;
    CtxDumpTokenVec *token_vecs;
    int token_vec_count;
} write_db_ctx_t;

/* Callback type for building a record from an item at index i. */
typedef uint8_t *(*build_record_fn)(const void *items, int i, int *out_len);
typedef int64_t (*get_rowid_fn)(const void *items, int i);

/* Write a streaming B-tree table from count items, or an empty table if count == 0. */
static int write_one_table(write_db_ctx_t *w, uint32_t *root, const void *items, int count,
                           build_record_fn build_rec, get_rowid_fn get_id) {
    if (count <= 0 || !items) {
        *root = write_table_btree(w->fp, &w->next_page, NULL, NULL, NULL, 0, false);
        return 0;
    }
    PageBuilder pb;
    pb_init(&pb, w->fp, w->next_page, false);
    for (int i = 0; i < count; i++) {
        int rec_len;
        uint8_t *rec = build_rec(items, i, &rec_len);
        if (!rec) {
            return ERR_WRITE_FAILED;
        }
        int64_t rowid = get_id(items, i);
        int64_t prev_id = i > 0 ? get_id(items, i - SKIP_ONE) : 0;
        pb_add_table_cell_with_flush(&pb, rowid, rec, rec_len, prev_id);
        free(rec);
    }
    *root = pb_finalize_table(&pb, &w->next_page, get_id(items, count - SKIP_ONE));
    return 0;
}

/* Wrapper structs so adapters can forward indexed_at to record builders. */
typedef struct {
    const CtxDumpNode *nodes;
    const char *indexed_at;
} NodeTableCtx;

typedef struct {
    const CtxDumpEdge *edges;
    const char *indexed_at;
} EdgeTableCtx;

/* Adapter functions for write_one_table */
static uint8_t *adapt_build_node(const void *items, int i, int *out_len) {
    const NodeTableCtx *ctx = (const NodeTableCtx *)items;
    return build_node_record(&ctx->nodes[i], ctx->indexed_at, out_len);
}
static int64_t adapt_node_id(const void *items, int i) {
    return ((const NodeTableCtx *)items)->nodes[i].id;
}
static uint8_t *adapt_build_edge(const void *items, int i, int *out_len) {
    const EdgeTableCtx *ctx = (const EdgeTableCtx *)items;
    return build_edge_record(&ctx->edges[i], ctx->indexed_at, out_len);
}
static int64_t adapt_edge_id(const void *items, int i) {
    return ((const EdgeTableCtx *)items)->edges[i].id;
}
static uint8_t *adapt_build_vector(const void *items, int i, int *out_len) {
    return build_vector_record(&((const CtxDumpVector *)items)[i], out_len);
}
static int64_t adapt_vector_id(const void *items, int i) {
    return ((const CtxDumpVector *)items)[i].node_id;
}
static uint8_t *adapt_build_token_vec(const void *items, int i, int *out_len) {
    return build_token_vec_record(&((const CtxDumpTokenVec *)items)[i], out_len);
}
static int64_t adapt_token_vec_id(const void *items, int i) {
    return ((const CtxDumpTokenVec *)items)[i].id;
}

/* Phase 1: Write node + edge + vector data tables (streaming). */
static int write_data_tables(write_db_ctx_t *w, uint32_t *nodes_root, uint32_t *edges_root,
                             uint32_t *vectors_root, uint32_t *token_vecs_root) {
    int rc;
    NodeTableCtx node_ctx = {w->nodes, w->indexed_at};
    rc = write_one_table(w, nodes_root, &node_ctx, w->node_count, adapt_build_node, adapt_node_id);
    if (rc != 0) {
        return rc;
    }
    EdgeTableCtx edge_ctx = {w->edges, w->indexed_at};
    rc = write_one_table(w, edges_root, &edge_ctx, w->edge_count, adapt_build_edge, adapt_edge_id);
    if (rc != 0) {
        return rc;
    }
    rc = write_one_table(w, vectors_root, w->vectors, w->vector_count, adapt_build_vector,
                         adapt_vector_id);
    if (rc != 0) {
        return rc;
    }
    rc = write_one_table(w, token_vecs_root, w->token_vecs, w->token_vec_count,
                         adapt_build_token_vec, adapt_token_vec_id);
    return rc;
}

/* Phase 2: Write metadata tables (projects, file_hashes, summaries, sqlite_sequence). */
static void write_metadata_tables(write_db_ctx_t *w, uint32_t *projects_root,
                                  uint32_t *file_hashes_root, uint32_t *summaries_root,
                                  uint32_t *sqlite_seq_root) {
    int proj_rec_len;
    uint8_t *proj_rec =
        build_project_record(w->project, w->indexed_at, w->root_path, &proj_rec_len);
    const uint8_t *proj_recs[] = {proj_rec};
    int proj_lens[] = {proj_rec_len};
    int64_t proj_rowids[] = {FIRST_ROWID};
    *projects_root =
        write_table_btree(w->fp, &w->next_page, proj_recs, proj_lens, proj_rowids, SKIP_ONE, false);
    free(proj_rec);

    *file_hashes_root = write_table_btree(w->fp, &w->next_page, NULL, NULL, NULL, 0, false);
    *summaries_root = write_table_btree(w->fp, &w->next_page, NULL, NULL, NULL, 0, false);

    /* Cortex schema uses TEXT PKs — no AUTOINCREMENT tables. sqlite_sequence stays empty. */
    *sqlite_seq_root = write_table_btree(w->fp, &w->next_page, NULL, NULL, NULL, 0, false);
}

/* Write the SQLite file header on page 1 with master entries. */
static void write_sqlite_file_header(uint8_t *page1, uint32_t total_pages) {
    memcpy(page1, "SQLite format 3\000", 16);
    put_u16(page1 + HDR_OFF_CTX_PAGE_SIZE,
            CTX_PAGE_SIZE == SQLITE_MAX_PAGE_SIZE ? (uint16_t)SKIP_ONE : (uint16_t)CTX_PAGE_SIZE);
    page1[HDR_OFF_WRITE_VERSION] = FILE_FORMAT;
    page1[HDR_OFF_READ_VERSION] = FILE_FORMAT;
    page1[HDR_OFF_RESERVED] = 0;
    page1[HDR_OFF_MAX_EMBED_FRAC] = MAX_EMBED_FRACTION;
    page1[HDR_OFF_MIN_EMBED_FRAC] = MIN_EMBED_FRACTION;
    page1[HDR_OFF_LEAF_FRAC] = LEAF_PAYLOAD_FRACTION;
    put_u32(page1 + HDR_OFF_FILE_CHANGE, SKIP_ONE);
    put_u32(page1 + HDR_OFF_DB_SIZE, total_pages);
    put_u32(page1 + HDR_OFF_FREELIST_TRUNK, 0);
    put_u32(page1 + HDR_OFF_FREELIST_COUNT, 0);
    put_u32(page1 + HDR_OFF_SCHEMA_COOKIE, SKIP_ONE);
    put_u32(page1 + HDR_OFF_SCHEMA_FORMAT, SCHEMA_FORMAT);
    put_u32(page1 + HDR_OFF_DEFAULT_CACHE, 0);
    put_u32(page1 + HDR_OFF_AUTOVAC_TOP, 0);
    put_u32(page1 + HDR_OFF_TEXT_ENCODING, SKIP_ONE);
    put_u32(page1 + HDR_OFF_USER_VERSION, 0);
    put_u32(page1 + HDR_OFF_INCR_VACUUM, 0);
    put_u32(page1 + HDR_OFF_APP_ID, 0);
    put_u32(page1 + HDR_OFF_VERSION_VALID, SKIP_ONE);
    put_u32(page1 + HDR_OFF_SQLITE_VERSION, SQLITE_VERSION);
}

/* Build master records, write page 1 B-tree + file header. */
static int write_master_page1(FILE *fp, MasterEntry *master, int master_count, uint32_t next_page) {
    const uint8_t **master_records = (const uint8_t **)malloc(master_count * sizeof(uint8_t *));
    int *master_lens = (int *)malloc(master_count * sizeof(int));
    int64_t *master_rowids = (int64_t *)malloc(master_count * sizeof(int64_t));
    for (int i = 0; i < master_count; i++) {
        master_rowids[i] = i + SKIP_ONE;
        master_records[i] = build_master_record(&master[i], &master_lens[i]);
    }

    uint8_t page1[CTX_PAGE_SIZE];
    memset(page1, 0, CTX_PAGE_SIZE);
    int hdr = SQLITE_HEADER_SIZE;
    page1[hdr] = BTREE_LEAF_TABLE;
    int content_off = CTX_PAGE_SIZE;
    int ptr_off = hdr + BTREE_HEADER_SIZE;
    int mcell_count = 0;

    for (int i = 0; i < master_count; i++) {
        int cell_len = 0;
        uint8_t *cell =
            build_table_cell(master_rowids[i], master_records[i], master_lens[i], &cell_len);
        int available = content_off - ptr_off - CELL_PTR_SIZE;
        if (!cell || cell_len > available) {
            free(cell);
            for (int j = 0; j < master_count; j++) {
                free((void *)master_records[j]);
            }
            free(master_records);
            free(master_lens);
            free(master_rowids);
            return ERR_MASTER_OVERFLOW;
        }
        content_off -= cell_len;
        memcpy(page1 + content_off, cell, cell_len);
        put_u16(page1 + ptr_off, (uint16_t)content_off);
        ptr_off += CELL_PTR_SIZE;
        mcell_count++;
        free(cell);
    }

    put_u16(page1 + hdr + HDR_FREEBLOCK_OFF, 0);
    put_u16(page1 + hdr + HDR_CELLCOUNT_OFF, (uint16_t)mcell_count);
    put_u16(page1 + hdr + HDR_CONTENT_OFF, (uint16_t)content_off);
    page1[hdr + HDR_FRAGBYTES_OFF] = 0;

    write_sqlite_file_header(page1, next_page - SKIP_ONE);

    (void)fseek(fp, 0, SEEK_SET);
    (void)fwrite(page1, SKIP_ONE, CTX_PAGE_SIZE, fp);

    for (int i = 0; i < master_count; i++) {
        free((void *)master_records[i]);
    }
    free(master_records);
    free(master_lens);
    free(master_rowids);
    return 0;
}

/* Pad file to exact page boundary. */
static void pad_file_to_page_boundary(FILE *fp, uint32_t next_page) {
    (void)fseek(fp, 0, SEEK_END);
    long file_size = ftell(fp);
    long expected_size = (long)(next_page - SKIP_ONE) * CTX_PAGE_SIZE;
    if (file_size < expected_size) {
        uint8_t zero = 0;
        (void)fseek(fp, expected_size - SKIP_ONE, SEEK_SET);
        (void)fwrite(&zero, SKIP_ONE, SKIP_ONE, fp);
    }
}

/* Build all 7 node index B-trees (Cortex schema). Returns 0 on success. */
static int build_node_indexes(FILE *fp, uint32_t *next_page, CtxDumpNode *nodes, int node_count,
                              SortJob *nsorts,
                              uint32_t *kind_root, uint32_t *name_root, uint32_t *qn_root,
                              uint32_t *file_root, uint32_t *tier_root,
                              uint32_t *kind_project_root, uint32_t *kind_file_root) {
    *kind_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                         nsorts[0].perm, ncell_kind);
    *name_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                         nsorts[NSORT_NAME].perm, ncell_name);
    *qn_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                        nsorts[NSORT_QN].perm, ncell_qn);
    *file_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                          nsorts[NSORT_FILE].perm, ncell_file);
    *tier_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                          nsorts[NSORT_TIER].perm, ncell_tier);
    *kind_project_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                                  nsorts[NSORT_KIND_PROJECT].perm, ncell_kind_project);
    *kind_file_root = build_node_index_sorted(fp, next_page, nodes, node_count,
                                               nsorts[NSORT_KIND_FILE].perm, ncell_kind_file);
    if (node_count > 0 && (!*kind_root || !*name_root || !*qn_root || !*file_root ||
                           !*tier_root || !*kind_project_root || !*kind_file_root)) {
        return ERR_SORT_FAILED;
    }
    return 0;
}

/* Build all 4 edge index B-trees (Cortex schema). Returns 0 on success. */
static int build_edge_indexes(FILE *fp, uint32_t *next_page, CtxDumpEdge *edges, int edge_count,
                              SortJob *esorts,
                              uint32_t *source_root, uint32_t *target_root,
                              uint32_t *relation_root, uint32_t *proj_relation_root) {
    *source_root =
        build_edge_index_sorted(fp, next_page, edges, edge_count, esorts[0].perm, ecell_source);
    *target_root =
        build_edge_index_sorted(fp, next_page, edges, edge_count, esorts[ESORT_TARGET].perm, ecell_target);
    *relation_root =
        build_edge_index_sorted(fp, next_page, edges, edge_count, esorts[ESORT_RELATION].perm, ecell_relation);
    *proj_relation_root =
        build_edge_index_sorted(fp, next_page, edges, edge_count, esorts[ESORT_PROJ_RELATION].perm, ecell_proj_relation);
    if (edge_count > 0 && (!*source_root || !*target_root || !*relation_root || !*proj_relation_root)) {
        return ERR_SORT_FAILED;
    }
    return 0;
}

/* Launch parallel sort threads for all index permutations. */
static void parallel_sort_indexes(SortJob *nsorts, int n_node, SortJob *esorts, int n_edge) {
    ctx_thread_t st[TOTAL_SORT_THREADS];
    int nt = 0;
    for (int i = 0; i < n_node; i++) {
        if (nsorts[i].count > 0) {
            ctx_thread_create(&st[nt++], 0, sort_worker, &nsorts[i]);
        }
    }
    for (int i = 0; i < n_edge; i++) {
        if (esorts[i].count > 0) {
            ctx_thread_create(&st[nt++], 0, sort_worker, &esorts[i]);
        }
    }
    for (int i = 0; i < nt; i++) {
        ctx_thread_join(&st[i]);
    }
}

int ctx_write_db(const char *path, const char *project, const char *root_path,
                 const char *indexed_at, CtxDumpNode *nodes, int node_count, CtxDumpEdge *edges,
                 int edge_count, CtxDumpVector *vectors, int vector_count,
                 CtxDumpTokenVec *token_vecs, int token_vec_count) {
    FILE *fp = fopen(path, "wb");
    if (!fp) {
        return CTX_NOT_FOUND;
    }

    write_db_ctx_t w = {.fp = fp,
                        .next_page = FIRST_DATA_PAGE,
                        .project = project,
                        .root_path = root_path,
                        .indexed_at = indexed_at,
                        .nodes = nodes,
                        .node_count = node_count,
                        .edges = edges,
                        .edge_count = edge_count,
                        .vectors = vectors,
                        .vector_count = vector_count,
                        .token_vecs = token_vecs,
                        .token_vec_count = token_vec_count};

    // Phase 1: Data tables (streaming node + edge + vector + token_vector records)
    CTX_PROF_START(t_data);
    uint32_t nodes_root;
    uint32_t edges_root;
    uint32_t vectors_root;
    uint32_t token_vecs_root;
    int rc = write_data_tables(&w, &nodes_root, &edges_root, &vectors_root, &token_vecs_root);
    if (rc != 0) {
        (void)fclose(fp);
        return rc;
    }
    CTX_PROF_END_N("write_db", "1_data_tables", t_data, node_count + edge_count);

    // Phase 2: Metadata tables (projects, file_hashes, summaries, sqlite_sequence)
    CTX_PROF_START(t_meta);
    uint32_t projects_root;
    uint32_t file_hashes_root;
    uint32_t summaries_root;
    uint32_t sqlite_seq_root;
    write_metadata_tables(&w, &projects_root, &file_hashes_root, &summaries_root, &sqlite_seq_root);
    uint32_t next_page = w.next_page;
    CTX_PROF_END("write_db", "2_metadata_tables", t_meta);

    // --- Build indexes (all sorted by key columns before writing) ---

    // Set sort contexts for qsort comparators.
    g_sort_nodes = nodes;
    g_sort_edges = edges;

    // Parallel sort: all 11 index permutations sorted simultaneously.
    // Sorting is O(N log N) per index — the dominant CPU cost in index building.
    // Cell building + B-tree writing remains serial (sequential page allocation).
    /* SortJob order MUST match the NSORT_ and ESORT_ enum values in this file.
     * NSORT: KIND=0, NAME=1, QN=2, FILE=3, TIER=4, KIND_PROJECT=5, KIND_FILE=6
     * ESORT: SOURCE=0, TARGET=1, RELATION=2, PROJ_RELATION=3 */
    SortJob nsorts[] = {
        {node_count, cmp_node_by_label, NULL},          /* idx_nodes_kind */
        {node_count, cmp_node_by_name, NULL},
        {node_count, cmp_node_by_qn, NULL},
        {node_count, cmp_node_by_file, NULL},
        {node_count, cmp_node_by_tier, NULL},
        {node_count, cmp_node_by_kind_project, NULL},
        {node_count, cmp_node_by_kind_file, NULL},
    };
    SortJob esorts[] = {
        {edge_count, cmp_edge_by_source, NULL},
        {edge_count, cmp_edge_by_target, NULL},
        {edge_count, cmp_edge_by_relation, NULL},
        {edge_count, cmp_edge_by_proj_relation, NULL},
    };

    CTX_PROF_START(t_sort);
    parallel_sort_indexes(nsorts, NODE_SORT_THREADS, esorts, EDGE_SORT_THREADS);
    CTX_PROF_END_N("write_db", "3_parallel_sort_indexes", t_sort, node_count + edge_count);

    /* Phase 4-5: Build node + edge index B-trees (Cortex schema). */
    CTX_PROF_START(t_node_idx);
    uint32_t idx_nodes_kind_root;
    uint32_t idx_nodes_name_root;
    uint32_t idx_nodes_qn_root;
    uint32_t idx_nodes_file_root;
    uint32_t idx_nodes_tier_root;
    uint32_t idx_nodes_kind_project_root;
    uint32_t idx_nodes_kind_file_root;
    int nrc = build_node_indexes(fp, &next_page, nodes, node_count, nsorts,
                                 &idx_nodes_kind_root, &idx_nodes_name_root,
                                 &idx_nodes_qn_root, &idx_nodes_file_root,
                                 &idx_nodes_tier_root, &idx_nodes_kind_project_root,
                                 &idx_nodes_kind_file_root);
    CTX_PROF_END_N("write_db", "4_node_indexes_seq", t_node_idx, node_count * NODE_SORT_THREADS);
    if (nrc != 0) {
        (void)fclose(fp);
        return nrc;
    }

    /* Autoindex for nodes(id TEXT PK). For TEXT PRIMARY KEY (no rowid alias),
     * SQLite expects a populated UNIQUE index mapping (id_text → rowid). Cells
     * must be sorted lexicographically by id_text. The integer counter we use
     * for both rowid and the int suffix in 'ctx-<int>' is sequential, but text
     * sort order ≠ int sort order ('ctx-10' < 'ctx-2'), so we sort by formatted
     * text. */
    uint32_t autoindex_nodes_root = 0;
    if (node_count > 0) {
        int *node_perm = (int *)malloc(node_count * sizeof(int));
        for (int i = 0; i < node_count; i++) node_perm[i] = i;
        /* Reuse cmp_node_by_label-style approach but sort by formatted id text. */
        struct { CtxDumpNode *base; } pctx = {nodes};
        (void)pctx;  /* qsort_r is portability-fragile; use a small inline sort below. */
        /* Insertion sort — node_count is small enough relative to other sorts. */
        for (int i = 1; i < node_count; i++) {
            int key = node_perm[i];
            char key_buf[32];
            format_node_id(key_buf, sizeof(key_buf), nodes[key].id);
            int j = i - 1;
            while (j >= 0) {
                char cmp_buf[32];
                format_node_id(cmp_buf, sizeof(cmp_buf), nodes[node_perm[j]].id);
                if (strcmp(cmp_buf, key_buf) <= 0) break;
                node_perm[j + 1] = node_perm[j];
                j--;
            }
            node_perm[j + 1] = key;
        }
        uint8_t **cells = (uint8_t **)malloc(node_count * sizeof(uint8_t *));
        int *lens = (int *)malloc(node_count * sizeof(int));
        for (int i = 0; i < node_count; i++) {
            char id_buf[32];
            format_node_id(id_buf, sizeof(id_buf), nodes[node_perm[i]].id);
            cells[i] = build_index_entry_1text_rowid(id_buf, nodes[node_perm[i]].id, &lens[i]);
        }
        autoindex_nodes_root = write_index_btree(fp, &next_page, cells, lens, node_count);
        for (int i = 0; i < node_count; i++) free(cells[i]);
        free(cells);
        free(lens);
        free(node_perm);
    } else {
        autoindex_nodes_root = write_index_btree(fp, &next_page, NULL, NULL, 0);
    }

    CTX_PROF_START(t_edge_idx);
    uint32_t idx_edges_source_root;
    uint32_t idx_edges_target_root;
    uint32_t idx_edges_relation_root;
    uint32_t idx_edges_proj_relation_root;
    int erc = build_edge_indexes(fp, &next_page, edges, edge_count, esorts,
                                 &idx_edges_source_root, &idx_edges_target_root,
                                 &idx_edges_relation_root, &idx_edges_proj_relation_root);
    CTX_PROF_END_N("write_db", "5_edge_indexes_seq", t_edge_idx, edge_count * EDGE_SORT_THREADS);
    if (erc != 0) {
        (void)fclose(fp);
        return erc;
    }

    /* Autoindex for edges(id TEXT PK). Same rationale as nodes; lexicographic
     * sort over 'ctx-e<int>'. */
    uint32_t autoindex_edges_root = 0;
    if (edge_count > 0) {
        int *edge_perm = (int *)malloc(edge_count * sizeof(int));
        for (int i = 0; i < edge_count; i++) edge_perm[i] = i;
        for (int i = 1; i < edge_count; i++) {
            int key = edge_perm[i];
            char key_buf[32];
            format_edge_id(key_buf, sizeof(key_buf), edges[key].id);
            int j = i - 1;
            while (j >= 0) {
                char cmp_buf[32];
                format_edge_id(cmp_buf, sizeof(cmp_buf), edges[edge_perm[j]].id);
                if (strcmp(cmp_buf, key_buf) <= 0) break;
                edge_perm[j + 1] = edge_perm[j];
                j--;
            }
            edge_perm[j + 1] = key;
        }
        uint8_t **cells = (uint8_t **)malloc(edge_count * sizeof(uint8_t *));
        int *lens = (int *)malloc(edge_count * sizeof(int));
        for (int i = 0; i < edge_count; i++) {
            char id_buf[32];
            format_edge_id(id_buf, sizeof(id_buf), edges[edge_perm[i]].id);
            cells[i] = build_index_entry_1text_rowid(id_buf, edges[edge_perm[i]].id, &lens[i]);
        }
        autoindex_edges_root = write_index_btree(fp, &next_page, cells, lens, edge_count);
        for (int i = 0; i < edge_count; i++) free(cells[i]);
        free(cells);
        free(lens);
        free(edge_perm);
    } else {
        autoindex_edges_root = write_index_btree(fp, &next_page, NULL, NULL, 0);
    }

    // Autoindex for projects(name TEXT PK) — single text column
    uint32_t autoindex_projects_root;
    {
        // 1 row: project name
        RecordBuilder r;
        rec_init(&r);
        rec_add_text(&r, project);
        rec_add_int(&r, FIRST_ROWID); /* rowid */
        int plen = 0;
        uint8_t *payload = rec_finalize(&r, &plen);
        rec_free(&r);
        int vl = varint_len(plen);
        int total = vl + plen;
        uint8_t *cell = (uint8_t *)malloc(total);
        int pos = put_varint(cell, plen);
        memcpy(cell + pos, payload, plen);
        free(payload);
        uint8_t *cells_arr[] = {cell};
        int lens_arr[] = {total};
        autoindex_projects_root = write_index_btree(fp, &next_page, cells_arr, lens_arr, SKIP_ONE);
        free(cell);
    }

    // Autoindex for file_hashes(project, rel_path PK) — empty (0 rows)
    uint32_t autoindex_file_hashes_root = write_index_btree(fp, &next_page, NULL, NULL, 0);

    // Autoindex for project_summaries(project TEXT PK) — empty (0 rows)
    uint32_t autoindex_summaries_root = write_index_btree(fp, &next_page, NULL, NULL, 0);

    // --- sqlite_master table (page 1) ---
    // This must be written last because it references root pages of all other tables/indexes.

    // CRITICAL: sqlite_master entries must follow standard SQLite ordering:
    // table → autoindex → user indexes → next table → autoindex → user indexes → ...
    // SQLite's schema loader expects autoindexes immediately after their table.
    // Mis-ordering causes rootpage mapping corruption in the schema cache.
    /* DDL strings here MUST match Cortex's CREATE_TABLES + CREATE_INDEXES in
     * src/graph/schema.ts exactly so that when GraphStore opens the DB and runs
     * `CREATE TABLE IF NOT EXISTS nodes (...)`, the IF NOT EXISTS sees a matching
     * existing schema and skips. Whitespace in the DDL is faithfully preserved. */
    MasterEntry master[] = {
        /* Cortex-owned data tables (post-Phase-4). */
        {"table", "nodes", "nodes", nodes_root,
         "CREATE TABLE nodes (\n  id          TEXT PRIMARY KEY,\n  kind        TEXT NOT NULL,\n  "
         "name        TEXT NOT NULL,\n  qualified_name TEXT,\n  file_path   TEXT,\n  data        "
         "TEXT NOT NULL DEFAULT '{}',\n  tier        TEXT NOT NULL DEFAULT 'personal',\n  "
         "created_at  TEXT NOT NULL,\n  updated_at  TEXT NOT NULL,\n  start_line  INTEGER,\n  "
         "end_line    INTEGER,\n  project     TEXT\n)"},
        {"index", "sqlite_autoindex_nodes_1", "nodes", autoindex_nodes_root, NULL},
        {"index", "idx_nodes_kind", "nodes", idx_nodes_kind_root,
         "CREATE INDEX idx_nodes_kind ON nodes(kind)"},
        {"index", "idx_nodes_name", "nodes", idx_nodes_name_root,
         "CREATE INDEX idx_nodes_name ON nodes(name)"},
        {"index", "idx_nodes_qualified_name", "nodes", idx_nodes_qn_root,
         "CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name)"},
        {"index", "idx_nodes_file_path", "nodes", idx_nodes_file_root,
         "CREATE INDEX idx_nodes_file_path ON nodes(file_path)"},
        {"index", "idx_nodes_tier", "nodes", idx_nodes_tier_root,
         "CREATE INDEX idx_nodes_tier ON nodes(tier)"},
        {"index", "idx_nodes_kind_project", "nodes", idx_nodes_kind_project_root,
         "CREATE INDEX idx_nodes_kind_project ON nodes(kind, project)"},
        {"index", "idx_nodes_kind_file", "nodes", idx_nodes_kind_file_root,
         "CREATE INDEX idx_nodes_kind_file ON nodes(kind, file_path)"},

        {"table", "edges", "edges", edges_root,
         "CREATE TABLE edges (\n  id          TEXT PRIMARY KEY,\n  source_id   TEXT NOT NULL "
         "REFERENCES nodes(id) ON DELETE CASCADE,\n  target_id   TEXT NOT NULL REFERENCES "
         "nodes(id) ON DELETE CASCADE,\n  relation    TEXT NOT NULL,\n  data        TEXT NOT "
         "NULL DEFAULT '{}',\n  created_at  TEXT NOT NULL,\n  project     TEXT\n)"},
        {"index", "sqlite_autoindex_edges_1", "edges", autoindex_edges_root, NULL},
        {"index", "idx_edges_source", "edges", idx_edges_source_root,
         "CREATE INDEX idx_edges_source ON edges(source_id)"},
        {"index", "idx_edges_target", "edges", idx_edges_target_root,
         "CREATE INDEX idx_edges_target ON edges(target_id)"},
        {"index", "idx_edges_relation", "edges", idx_edges_relation_root,
         "CREATE INDEX idx_edges_relation ON edges(relation)"},
        {"index", "idx_edges_project_relation", "edges", idx_edges_proj_relation_root,
         "CREATE INDEX idx_edges_project_relation ON edges(project, relation)"},

        /* Indexer-owned bookkeeping tables (formerly ctx_*). */
        {"table", "ctx_projects", "ctx_projects", projects_root,
         "CREATE TABLE ctx_projects (\n\t\tname TEXT PRIMARY KEY,\n\t\tindexed_at TEXT NOT "
         "NULL,\n\t\troot_path TEXT NOT NULL\n\t)"},
        {"index", "sqlite_autoindex_ctx_projects_1", "ctx_projects", autoindex_projects_root, NULL},
        {"table", "ctx_file_hashes", "ctx_file_hashes", file_hashes_root,
         "CREATE TABLE ctx_file_hashes (\n\t\tproject TEXT NOT NULL REFERENCES ctx_projects(name) "
         "ON DELETE CASCADE,\n\t\trel_path TEXT NOT NULL,\n\t\tsha256 TEXT NOT NULL,\n\t\tmtime_ns "
         "INTEGER NOT NULL DEFAULT 0,\n\t\tsize INTEGER NOT NULL DEFAULT 0,\n\t\tPRIMARY KEY "
         "(project, rel_path)\n\t)"},
        {"index", "sqlite_autoindex_ctx_file_hashes_1", "ctx_file_hashes",
         autoindex_file_hashes_root, NULL},
        {"table", "ctx_project_summaries", "ctx_project_summaries", summaries_root,
         "CREATE TABLE ctx_project_summaries (\n\t\t\tproject TEXT PRIMARY KEY,\n\t\t\tsummary "
         "TEXT NOT NULL,\n\t\t\tsource_hash TEXT NOT NULL,\n\t\t\tcreated_at TEXT NOT "
         "NULL,\n\t\t\tupdated_at TEXT NOT NULL\n\t\t)"},
        {"index", "sqlite_autoindex_ctx_project_summaries_1", "ctx_project_summaries",
         autoindex_summaries_root, NULL},
        {"table", "ctx_node_vectors", "ctx_node_vectors", vectors_root,
         "CREATE TABLE ctx_node_vectors (\n\t\tnode_id INTEGER PRIMARY KEY,\n\t\tproject TEXT NOT "
         "NULL,\n\t\tvector BLOB NOT NULL\n\t)"},
        {"table", "ctx_token_vectors", "ctx_token_vectors", token_vecs_root,
         "CREATE TABLE ctx_token_vectors (\n\t\tid INTEGER PRIMARY KEY,\n\t\tproject "
         "TEXT NOT NULL,\n\t\ttoken TEXT NOT NULL,\n\t\tvector BLOB NOT NULL,\n\t\tidf INTEGER "
         "NOT NULL\n\t)"},
        {"table", "sqlite_sequence", "sqlite_sequence", sqlite_seq_root,
         "CREATE TABLE sqlite_sequence(name,seq)"},
    };

    int master_count = sizeof(master) / sizeof(master[0]);
    int rc2 = write_master_page1(fp, master, master_count, next_page);
    if (rc2 != 0) {
        (void)fclose(fp);
        return rc2;
    }
    pad_file_to_page_boundary(fp, next_page);
    (void)fclose(fp);
    return 0;
}
