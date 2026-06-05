/**
 * Canonical paginator: per-page select + range text + nav chips.
 * Renders nothing when total is 0. Page index is zero-based.
 */

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  pageSizes?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const DEFAULT_SIZES = [10, 25, 50] as const;

export function Pagination({
  page,
  pageSize,
  total,
  pageSizes = DEFAULT_SIZES,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  if (total === 0) return null;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, total);

  return (
    <div className="pagination pagination-compact">
      <div className="page-size">
        <label className="form-label">Per page</label>
        <select
          className="form-input form-input-inline"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number.parseInt(e.target.value, 10))}
        >
          {pageSizes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <span className="header-spacer" />
      <span className="muted small">{start + 1}–{end} of {total}</span>
      <div className="page-nav">
        <button type="button" className="chip" disabled={currentPage === 0} onClick={() => onPageChange(0)}>«</button>
        <button type="button" className="chip" disabled={currentPage === 0} onClick={() => onPageChange(Math.max(0, currentPage - 1))}>‹</button>
        <span className="page-indicator mono">{currentPage + 1} / {pageCount}</span>
        <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => onPageChange(Math.min(pageCount - 1, currentPage + 1))}>›</button>
        <button type="button" className="chip" disabled={currentPage >= pageCount - 1} onClick={() => onPageChange(pageCount - 1)}>»</button>
      </div>
    </div>
  );
}
