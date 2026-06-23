// FILE: ~/otmega/otmega_app/console/admin_frontend/src/pages/UserOperationsPage.tsx
// ماموریت: جدول عملیاتی read-only کاربران، بنرلیست، استفاده و سلامت پیام/نوتیف.

import { Eye, EyeOff, Grip, Maximize2, RefreshCw, RotateCcw, Search, WrapText, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import {
  fetchConsoleDashboardSettings,
  fetchUserOperations,
  getUserOpsAvatarUrl,
  repairUserOpsActiveBanner,
  saveConsoleDashboardSettingsSection,
  type UserOpsBannerTarget,
  type UserOpsResponse,
  type UserOpsRow,
} from '../api/consoleApi';

type UserOpsColumnKey =
  | 'row'
  | 'user'
  | 'balance'
  | 'tier'
  | 'messages'
  | 'banners'
  | 'last_message'
  | 'online'
  | 'conversations'
  | 'notifications'
  | 'banner_list'
  | 'refresh';

type UserOpsColumn = {
  key: UserOpsColumnKey;
  label: string;
  sort?: string;
  defaultWidth: number;
  sticky?: 'row' | 'user';
  lockVisible?: boolean;
  render: (row: UserOpsRow, index: number, helpers: {
    rowNumber: (index: number) => number;
    refreshPage: () => void;
    loading: boolean;
    openBannerList: (row: UserOpsRow) => void;
  }) => ReactNode;
};

const USER_OPS_COLUMNS: UserOpsColumn[] = [
  {
    key: 'row',
    label: '#',
    sort: 'profile_order',
    defaultWidth: 58,
    sticky: 'row',
    lockVisible: true,
    render: (_row, index, helpers) => helpers.rowNumber(index),
  },
  {
    key: 'user',
    label: 'User',
    sort: 'email',
    defaultWidth: 330,
    sticky: 'user',
    lockVisible: true,
    render: (row) => (
      <span className="user-ops-user">
        {row.avatar_url ? <img alt="" src={row.avatar_url} /> : <i>{initials(row)}</i>}
        <b>{row.email || row.user_id}</b>
        <small>{row.full_name || row.user_id}</small>
        <small>{row.access_level} / {row.role}</small>
      </span>
    ),
  },
  { key: 'balance', label: 'OTCoin', sort: 'balance', defaultWidth: 110, render: (row) => row.balance },
  { key: 'tier', label: 'Tier', sort: 'tier', defaultWidth: 112, render: (row) => <span title={`${row.tier}`}>{stars(row.tier)}</span> },
  {
    key: 'messages',
    label: 'Messages',
    sort: 'messages_sent',
    defaultWidth: 120,
    render: (row) => (
      <>
        <b>{row.usage.messages_sent}</b>
        <small>{formatLatency(row.usage.last_message_latency_seconds)}</small>
      </>
    ),
  },
  {
    key: 'banners',
    label: 'Banners',
    sort: 'banner_count',
    defaultWidth: 154,
    render: (row) => (
      <>
        <b>{row.visibility.active_banner_count}</b>
        <small>{row.visibility.stored_active_relation_count ?? 0} active / {row.visibility.pending_banner_count} pending</small>
        <small>{row.visibility.invitation_banner_count ?? 0} invite / {row.visibility.warmable_chat_count ?? 0} warm</small>
      </>
    ),
  },
  {
    key: 'last_message',
    label: 'Last Message',
    sort: 'last_message_at',
    defaultWidth: 190,
    render: (row) => (
      <>
        <b>{formatDate(row.usage.last_message_at)}</b>
        <small>{row.online_status}</small>
      </>
    ),
  },
  { key: 'online', label: 'Online', sort: 'online_status', defaultWidth: 116, render: (row) => row.online_status },
  {
    key: 'conversations',
    label: 'Conversations',
    defaultWidth: 170,
    render: (row) => (
      <>
        <b>{row.usage.conversations.active_with_chat} chat</b>
        <small>
          {row.usage.conversations.banner_list_with_chat ?? row.usage.conversations.active_with_chat} banner / {row.usage.conversations.upstream_system_with_chat ?? 0} upstream
        </small>
        <small>{row.usage.conversations.active_without_chat} empty / {row.usage.conversations.unread_total} unread</small>
      </>
    ),
  },
  {
    key: 'notifications',
    label: 'Notifications',
    defaultWidth: 190,
    render: (row) => (
      <>
        <b>{row.notifications.system_notification_tokens} system</b>
        <small>{row.notifications.internal_notification_markers} internal / {row.usage.notifications.system_push_total} push rows</small>
      </>
    ),
  },
  {
    key: 'banner_list',
    label: 'Banner list',
    defaultWidth: 360,
    render: (row, _index, helpers) => (
      <span className="user-ops-banners">
        <button className="user-ops-banner-open" onClick={() => helpers.openBannerList(row)} type="button">
          <Eye aria-hidden="true" size={14} />
          <span>{(row.visibility.visible_now_targets || row.visibility.active_targets).length} visible now</span>
        </button>
        <b onClick={() => helpers.openBannerList(row)} role="button" tabIndex={0}>
          {(row.visibility.visible_now_targets || row.visibility.active_targets).slice(0, 4).map(targetLabel).join(', ') || 'none'}
        </b>
        <small>
          visible {row.visibility.visible_banner_count ?? row.visibility.active_banner_count}
          {' / warm '}
          {row.visibility.warmable_chat_count ?? row.visibility.chat_banner_count ?? 0}
          {' / upstream '}
          {row.visibility.upstream_system_banner_count ?? 0}
          {' / required '}
          {row.visibility.required_banner_count ?? 0}
          {' / last '}
          {formatDate(row.visibility.visibility_changed_at)}
        </small>
      </span>
    ),
  },
  {
    key: 'refresh',
    label: 'Refresh',
    defaultWidth: 72,
    render: (_row, _index, helpers) => (
      <button className="console-icon-button" disabled={helpers.loading} onClick={helpers.refreshPage} title="Refresh current table" type="button">
        <RefreshCw aria-hidden="true" className={helpers.loading ? 'spin' : undefined} size={16} />
      </button>
    ),
  },
];

const DEFAULT_HIDDEN_COLUMNS = new Set<UserOpsColumnKey>(['online']);
const DEFAULT_BANNER_PANEL = { x: 760, y: 150, width: 420, height: 620 };
const USER_OPS_COLUMN_KEYS = new Set(USER_OPS_COLUMNS.map((column) => column.key));

function formatDate(value: string | null): string {
  if (!value) return 'unknown';
  return new Date(value).toLocaleString();
}

function formatLatency(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function stars(tier: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(tier || 0)));
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}`;
}

function initials(row: UserOpsRow): string {
  const source = row.full_name || row.email || row.user_id;
  return source.split(/[ .@_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'U';
}

function targetLabel(target: { full_name?: string | null; email?: string | null; user_id: string }): string {
  return target.full_name || target.email || target.user_id;
}

function targetInitials(target: { full_name?: string | null; email?: string | null; user_id: string }): string {
  return targetLabel(target).split(/[ .@_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'B';
}

type UserOperationsPageProps = {
  canRepair?: boolean;
};

function BannerTargetAvatar({ target, avatarUrl }: { target: UserOpsBannerTarget; avatarUrl?: string | null }) {
  const resolvedAvatarUrl = avatarUrl || target.avatar_url || null;
  return (
    <span className="user-ops-banner-avatar">
      {resolvedAvatarUrl ? <img alt="" src={resolvedAvatarUrl} /> : <i>{targetInitials(target)}</i>}
    </span>
  );
}

export default function UserOperationsPage({ canRepair = false }: UserOperationsPageProps) {
  const [payload, setPayload] = useState<UserOpsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState('profile_order');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [status, setStatus] = useState('all');
  const [onlineStatus, setOnlineStatus] = useState('all');
  const [hiddenColumns, setHiddenColumns] = useState<Set<UserOpsColumnKey>>(DEFAULT_HIDDEN_COLUMNS);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    Object.fromEntries(USER_OPS_COLUMNS.map((column) => [column.key, column.defaultWidth])),
  );
  const [density, setDensity] = useState<'compact' | 'normal' | 'roomy'>('compact');
  const [wrapCells, setWrapCells] = useState(false);
  const [rowHeight, setRowHeight] = useState(58);
  const [bannerPanelRow, setBannerPanelRow] = useState<UserOpsRow | null>(null);
  const [bannerPanel, setBannerPanel] = useState(DEFAULT_BANNER_PANEL);
  const [avatarUrlByPath, setAvatarUrlByPath] = useState<Record<string, string | null>>({});
  const [repairingTargetId, setRepairingTargetId] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const lastSavedUserOpsSettingsRef = useRef('');

  async function refreshUsers(nextPage = page) {
    setLoading(true);
    try {
      const nextPayload = await fetchUserOperations({
        page: nextPage,
        page_size: pageSize,
        sort,
        direction,
        search,
        role,
        status,
        online_status: onlineStatus,
      });
      setPayload(nextPayload);
      setPage(nextPayload.page);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'User operations failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetchConsoleDashboardSettings()
      .then((response) => {
        if (cancelled) return;
        const settings = response.settings.user_operations as Record<string, unknown> | undefined;
        if (!settings) return;

        const savedPage = Number(settings.page);
        const savedPageSize = Number(settings.pageSize);
        const savedSort = typeof settings.sort === 'string' ? settings.sort : '';
        const savedDirection = settings.direction === 'desc' ? 'desc' : settings.direction === 'asc' ? 'asc' : null;
        const savedHiddenColumns = Array.isArray(settings.hiddenColumns)
          ? settings.hiddenColumns.filter((key): key is UserOpsColumnKey => typeof key === 'string' && USER_OPS_COLUMN_KEYS.has(key as UserOpsColumnKey))
          : null;
        const savedWidths = settings.columnWidths && typeof settings.columnWidths === 'object' && !Array.isArray(settings.columnWidths)
          ? settings.columnWidths as Record<string, unknown>
          : null;
        const savedDensity = settings.density === 'compact' || settings.density === 'normal' || settings.density === 'roomy' ? settings.density : null;
        const savedPanel = settings.bannerPanel && typeof settings.bannerPanel === 'object' && !Array.isArray(settings.bannerPanel)
          ? settings.bannerPanel as Record<string, unknown>
          : null;

        if (Number.isFinite(savedPage) && savedPage >= 1) setPage(Math.floor(savedPage));
        if ([10, 25, 50, 100].includes(savedPageSize)) setPageSize(savedPageSize);
        if (savedSort) setSort(savedSort);
        if (savedDirection) setDirection(savedDirection);
        if (typeof settings.search === 'string') setSearch(settings.search.slice(0, 160));
        if (typeof settings.role === 'string') setRole(settings.role);
        if (typeof settings.status === 'string') setStatus(settings.status);
        if (typeof settings.onlineStatus === 'string') setOnlineStatus(settings.onlineStatus);
        if (savedHiddenColumns) setHiddenColumns(new Set(savedHiddenColumns));
        if (savedWidths) {
          setColumnWidths((current) => {
            const next = { ...current };
            Object.entries(savedWidths).forEach(([key, value]) => {
              if (USER_OPS_COLUMN_KEYS.has(key as UserOpsColumnKey) && Number.isFinite(Number(value))) {
                next[key] = Math.max(key === 'row' ? 48 : 84, Math.min(760, Number(value)));
              }
            });
            return next;
          });
        }
        if (savedDensity) setDensity(savedDensity);
        if (typeof settings.wrapCells === 'boolean') setWrapCells(settings.wrapCells);
        if (Number.isFinite(Number(settings.rowHeight))) setRowHeight(Math.max(46, Math.min(132, Number(settings.rowHeight))));
        if (savedPanel) {
          setBannerPanel({
            x: Math.max(360, Math.min(1800, Number(savedPanel.x) || DEFAULT_BANNER_PANEL.x)),
            y: Math.max(86, Math.min(1200, Number(savedPanel.y) || DEFAULT_BANNER_PANEL.y)),
            width: Math.max(320, Math.min(760, Number(savedPanel.width) || DEFAULT_BANNER_PANEL.width)),
            height: Math.max(320, Math.min(1100, Number(savedPanel.height) || DEFAULT_BANNER_PANEL.height)),
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setSettingsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (settingsReady) {
      refreshUsers(page);
    }
  }, [settingsReady]);

  useEffect(() => {
    if (!settingsReady) return;
    const section = {
      bannerPanel,
      columnWidths,
      density,
      direction,
      hiddenColumns: Array.from(hiddenColumns),
      onlineStatus,
      page,
      pageSize,
      role,
      rowHeight,
      search,
      sort,
      status,
      wrapCells,
    };
    const serialized = JSON.stringify(section);
    if (lastSavedUserOpsSettingsRef.current === serialized) return;
    lastSavedUserOpsSettingsRef.current = serialized;
    const timer = window.setTimeout(() => {
      void saveConsoleDashboardSettingsSection('user_operations', section).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    bannerPanel,
    columnWidths,
    density,
    direction,
    hiddenColumns,
    onlineStatus,
    page,
    pageSize,
    role,
    rowHeight,
    search,
    settingsReady,
    sort,
    status,
    wrapCells,
  ]);

  useEffect(() => {
    if (!bannerPanelRow) {
      return;
    }
    const targets = [
      ...(bannerPanelRow.visibility.visible_now_targets || bannerPanelRow.visibility.active_targets || []),
      ...(bannerPanelRow.visibility.warmable_chat_targets || []),
      ...(bannerPanelRow.visibility.excluded_targets || []),
    ];
    const paths = Array.from(new Set(
      targets
        .map((target) => target.avatar_path)
        .filter((path): path is string => Boolean(path)),
    )).filter((path) => avatarUrlByPath[path] === undefined).slice(0, 80);

    if (paths.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(paths.map(async (path) => {
      try {
        const response = await getUserOpsAvatarUrl(path);
        return [path, response.avatar_url || null] as const;
      } catch {
        return [path, null] as const;
      }
    })).then((entries) => {
      if (cancelled) {
        return;
      }
      setAvatarUrlByPath((current) => {
        const next = { ...current };
        entries.forEach(([path, url]) => {
          next[path] = url;
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [bannerPanelRow, avatarUrlByPath]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil((payload?.total || 0) / pageSize)), [payload?.total, pageSize]);
  const visibleColumns = useMemo(
    () => USER_OPS_COLUMNS.filter((column) => column.lockVisible || !hiddenColumns.has(column.key)),
    [hiddenColumns],
  );
  const rowColumnWidth = columnWidths.row || 58;
  const userColumnWidth = columnWidths.user || 330;
  const gridStyle = {
    '--user-ops-grid-columns': visibleColumns.map((column) => `${columnWidths[column.key] || column.defaultWidth}px`).join(' '),
    '--user-ops-row-width': `${rowColumnWidth}px`,
    '--user-ops-user-left': `${rowColumnWidth}px`,
    '--user-ops-user-width': `${userColumnWidth}px`,
    '--user-ops-row-height': `${rowHeight}px`,
  } as CSSProperties;

  function chooseSort(column: string) {
    if (sort === column) {
      setDirection(direction === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(column);
      setDirection('asc');
    }
  }

  function rowNumber(index: number): number {
    return ((payload?.page || page) - 1) * pageSize + index + 1;
  }

  function toggleColumn(columnKey: UserOpsColumnKey) {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (next.has(columnKey)) {
        next.delete(columnKey);
      } else {
        next.add(columnKey);
      }
      return next;
    });
  }

  function resetTableView() {
    setHiddenColumns(DEFAULT_HIDDEN_COLUMNS);
    setColumnWidths(Object.fromEntries(USER_OPS_COLUMNS.map((column) => [column.key, column.defaultWidth])));
    setDensity('compact');
    setWrapCells(false);
    setRowHeight(58);
  }

  function beginColumnResize(column: UserOpsColumnKey, event: MouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths[column] || USER_OPS_COLUMNS.find((item) => item.key === column)?.defaultWidth || 140;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const width = Math.max(column === 'row' ? 48 : 84, Math.min(760, startWidth + moveEvent.clientX - startX));
      setColumnWidths((current) => ({ ...current, [column]: width }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-sidebar');
    };
    document.body.classList.add('resizing-sidebar');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function headerCell(column: UserOpsColumn) {
    const activeSort = column.sort && sort === column.sort;
    const label = `${column.label}${activeSort ? ` ${direction.toUpperCase()}` : ''}`;
    return column.sort ? (
      <button onClick={() => chooseSort(column.sort || 'profile_order')} type="button">{label}</button>
    ) : (
      <span>{label}</span>
    );
  }

  function beginBannerPanelDrag(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = bannerPanel;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      setBannerPanel({
        ...start,
        x: Math.max(360, Math.min(window.innerWidth - 180, start.x + moveEvent.clientX - startX)),
        y: Math.max(86, Math.min(window.innerHeight - 120, start.y + moveEvent.clientY - startY)),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function beginBannerPanelResize(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = bannerPanel;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      setBannerPanel({
        ...start,
        width: Math.max(320, Math.min(760, start.width + moveEvent.clientX - startX)),
        height: Math.max(320, Math.min(window.innerHeight - 110, start.height + moveEvent.clientY - startY)),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async function repairBannerTarget(target: UserOpsBannerTarget, source: string) {
    if (!bannerPanelRow || !target.user_id || repairingTargetId) {
      return;
    }
    if (!target.repairable) {
      setRepairError(target.repair_block_reason ? `Repair is blocked: ${target.repair_block_reason}.` : 'This banner target is not repairable.');
      return;
    }
    const label = targetLabel(target);
    const ownerLabel = bannerPanelRow.email || bannerPanelRow.user_id;
    const accepted = window.confirm(`Repair banner list?\n\nAdd ${label} to ${ownerLabel}'s active_list_targets.\n\nThis is a real write.`);
    if (!accepted) {
      return;
    }
    setRepairingTargetId(target.user_id);
    setRepairError(null);
    try {
      await repairUserOpsActiveBanner({
        owner_user_id: bannerPanelRow.user_id,
        counterpart_user_id: target.user_id,
        reason: source,
      });
      await refreshUsers(page);
      setBannerPanelRow(null);
    } catch (repairException) {
      setRepairError(repairException instanceof Error ? repairException.message : 'Repair failed.');
    } finally {
      setRepairingTargetId(null);
    }
  }

  function beginRepairDrag(event: DragEvent<HTMLElement>, target: UserOpsBannerTarget) {
    event.dataTransfer.setData('application/x-user-ops-target', JSON.stringify({ user_id: target.user_id }));
    event.dataTransfer.effectAllowed = 'move';
  }

  function allowRepairDrop(event: DragEvent<HTMLElement>) {
    if (!canRepair) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function handleRepairDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (!bannerPanelRow || !canRepair) {
      return;
    }
    const rawPayload = event.dataTransfer.getData('application/x-user-ops-target');
    if (!rawPayload) {
      return;
    }
    try {
      const parsed = JSON.parse(rawPayload) as { user_id?: string };
      const target = (bannerPanelRow.visibility.warmable_chat_targets || []).find((item) => item.user_id === parsed.user_id);
      if (target?.repairable) {
        void repairBannerTarget(target, 'user_operations_drag_drop_chat_only_to_visible_now');
      }
    } catch {
      setRepairError('Dropped repair payload was invalid.');
    }
  }

  return (
    <section className="console-page">
      <div className="console-page-heading">
        <div>
          <h2>User Operations</h2>
          <p>Read-only user inventory, banner-list health, usage and notification signals.</p>
        </div>
        <button className="console-icon-text-button" disabled={loading} onClick={() => refreshUsers(page)} type="button">
          <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={17} />
          <span>{loading ? 'Refreshing' : 'Refresh All'}</span>
        </button>
      </div>

      <section className="console-panel user-ops-view-controls">
        <div className="user-ops-control-group">
          <span className="console-label">Columns</span>
          {USER_OPS_COLUMNS.filter((column) => !column.lockVisible).map((column) => (
            <button className={hiddenColumns.has(column.key) ? '' : 'active'} key={column.key} onClick={() => toggleColumn(column.key)} type="button">
              {hiddenColumns.has(column.key) ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
              <span>{column.label}</span>
            </button>
          ))}
        </div>
        <div className="user-ops-control-group user-ops-density">
          <span className="console-label">Density</span>
          {(['compact', 'normal', 'roomy'] as const).map((option) => (
            <button className={density === option ? 'active' : ''} key={option} onClick={() => setDensity(option)} type="button">{option}</button>
          ))}
          <button className={wrapCells ? 'active' : ''} onClick={() => setWrapCells((current) => !current)} type="button">
            <WrapText aria-hidden="true" size={14} />
            <span>Wrap</span>
          </button>
          <label className="user-ops-row-height">
            <span>Row</span>
            <input max={132} min={46} onChange={(event) => setRowHeight(Number(event.target.value))} type="range" value={rowHeight} />
            <small>{rowHeight}px</small>
          </label>
          <button onClick={resetTableView} type="button">
            <RotateCcw aria-hidden="true" size={14} />
            <span>Reset</span>
          </button>
        </div>
      </section>

      <div className={`user-ops-filters ${loading ? 'is-loading' : ''}`}>
        <label className="user-ops-search">
          <Search aria-hidden="true" size={16} />
          <input onChange={(event) => setSearch(event.target.value)} placeholder="Search email, name, user id" value={search} />
        </label>
        <select onChange={(event) => setRole(event.target.value)} value={role}>
          <option value="all">All roles</option>
          <option value="guest">Guest</option>
          <option value="customer">Customer</option>
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
          <option value="s_admin">S Admin</option>
        </select>
        <select onChange={(event) => setStatus(event.target.value)} value={status}>
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="blocked">Blocked</option>
          <option value="inactive">Inactive</option>
        </select>
        <select onChange={(event) => setOnlineStatus(event.target.value)} value={onlineStatus}>
          <option value="all">All online</option>
          <option value="online">Online</option>
          <option value="away">Away</option>
          <option value="busy">Busy</option>
          <option value="offline">Offline</option>
          <option value="blocked">Blocked</option>
        </select>
        <select onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}>
          <option value={10}>10 rows</option>
          <option value={25}>25 rows</option>
          <option value={50}>50 rows</option>
          <option value={100}>100 rows</option>
        </select>
        <button className="console-icon-text-button" disabled={loading} onClick={() => refreshUsers(1)} type="button">
          <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={16} />
          <span>{loading ? 'Applying' : 'Apply'}</span>
        </button>
      </div>

      {loading ? (
        <div className="user-ops-loading-strip">
          <span className="wave-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>Updating user operations table...</span>
        </div>
      ) : null}

      {error ? <div className="console-error">{error}</div> : null}

      <div className={`user-ops-summary ${loading ? 'is-loading' : ''}`}>
        <article className="console-panel">
          <span className="console-label">Rows</span>
          <strong>{payload?.rows.length ?? 0}</strong>
          <p>{payload ? `${payload.total} total / page ${payload.page}` : 'loading users'}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Sort</span>
          <strong>{sort}</strong>
          <p>{direction}</p>
        </article>
        <article className="console-panel">
          <span className="console-label">Last Probe</span>
          <strong>{payload ? formatDate(payload.timestamp) : loading ? 'loading' : 'unknown'}</strong>
          <p>read-only</p>
        </article>
      </div>

      <article className={`user-ops-table-wrap density-${density} ${wrapCells ? 'wrap-cells' : 'nowrap-cells'} ${loading ? 'is-loading' : ''}`} style={gridStyle}>
        <div className="user-ops-table">
          <div className="user-ops-row user-ops-row-head">
            {visibleColumns.map((column) => (
              <div className={`user-ops-cell user-ops-col-${column.key} ${column.sticky ? `sticky-${column.sticky}` : ''}`} key={column.key}>
                {headerCell(column)}
                <span className="user-ops-resizer" onMouseDown={(event) => beginColumnResize(column.key, event)} />
              </div>
            ))}
          </div>
          {(payload?.rows || []).map((row, index) => (
            <div className="user-ops-row" key={row.user_id}>
              {visibleColumns.map((column) => (
                <div className={`user-ops-cell user-ops-col-${column.key} ${column.sticky ? `sticky-${column.sticky}` : ''}`} key={`${row.user_id}:${column.key}`}>
                  {column.render(row, index, { rowNumber, refreshPage: () => refreshUsers(page), loading, openBannerList: setBannerPanelRow })}
                </div>
              ))}
            </div>
          ))}
          {!loading && payload?.rows.length === 0 ? <div className="user-ops-empty">No users returned.</div> : null}
        </div>
      </article>

      <div className="user-ops-pager">
        <button className="console-secondary-button" disabled={loading || page <= 1} onClick={() => refreshUsers(page - 1)} type="button">Previous</button>
        <span>{loading ? 'Loading...' : `Page ${page} / ${totalPages}`}</span>
        <button className="console-secondary-button" disabled={loading || page >= totalPages} onClick={() => refreshUsers(page + 1)} type="button">Next</button>
      </div>

      {bannerPanelRow ? (
        <aside
          className="user-ops-banner-panel"
          style={{ left: bannerPanel.x, top: bannerPanel.y, width: bannerPanel.width, height: bannerPanel.height }}
        >
          <header onMouseDown={beginBannerPanelDrag}>
            <Grip aria-hidden="true" size={16} />
            <div>
              <strong>{bannerPanelRow.email || bannerPanelRow.user_id}</strong>
              <small>
                visible {bannerPanelRow.visibility.visible_banner_count ?? bannerPanelRow.visibility.active_banner_count}
                {' / warm '}
                {bannerPanelRow.visibility.warmable_chat_count ?? 0}
                {' / active '}
                {bannerPanelRow.visibility.stored_active_relation_count ?? 0}
                {' / pending '}
                {bannerPanelRow.visibility.pending_banner_count ?? 0}
              </small>
            </div>
            <button onClick={() => setBannerPanel(DEFAULT_BANNER_PANEL)} onMouseDown={(event) => event.stopPropagation()} title="Reset panel size" type="button">
              <Maximize2 aria-hidden="true" size={15} />
            </button>
            <button onClick={() => setBannerPanelRow(null)} onMouseDown={(event) => event.stopPropagation()} title="Close banner list" type="button">
              <X aria-hidden="true" size={16} />
            </button>
          </header>
          <div className="user-ops-banner-phone">
            <div className="user-ops-banner-owner">
              <span className="user-ops-banner-avatar owner">
                {bannerPanelRow.avatar_url ? <img alt="" src={bannerPanelRow.avatar_url} /> : <i>{initials(bannerPanelRow)}</i>}
              </span>
              <div>
                <b>{bannerPanelRow.full_name || bannerPanelRow.email || bannerPanelRow.user_id}</b>
                <small>{bannerPanelRow.access_level} / {bannerPanelRow.online_status}</small>
              </div>
              <strong>{bannerPanelRow.balance} Φ</strong>
            </div>
            <div className="user-ops-banner-list">
              {repairError ? <div className="console-error user-ops-repair-error">{repairError}</div> : null}
              <h4>Visible now</h4>
              <div
                className={`user-ops-repair-dropzone ${canRepair ? 'enabled' : ''}`}
                onDragOver={allowRepairDrop}
                onDrop={handleRepairDrop}
              >
                <small>{canRepair ? 'Drop repairable chat-only banners here to repair this user list.' : 'Repair capability is not available for this session.'}</small>
              </div>
              {(bannerPanelRow.visibility.visible_now_targets || bannerPanelRow.visibility.active_targets).map((target, index) => {
                const label = targetLabel(target);
                return (
                  <article className="user-ops-banner-card" key={`${target.user_id}:${index}`}>
                    <BannerTargetAvatar avatarUrl={target.avatar_path ? avatarUrlByPath[target.avatar_path] : null} target={target} />
                    <div>
                      <b>{label}</b>
                      <small>{target.email || target.user_id}</small>
                    </div>
                    <span className="user-ops-banner-state">{target.state || target.source || 'banner'}{target.has_chat ? ' / chat' : ''}</span>
                  </article>
                );
              })}
              {(bannerPanelRow.visibility.visible_now_targets || bannerPanelRow.visibility.active_targets).length === 0 ? <p>No visible banner targets returned for this refresh.</p> : null}

              {(bannerPanelRow.visibility.warmable_chat_targets || []).length > 0 ? <h4>Warmable chats</h4> : null}
              {(bannerPanelRow.visibility.warmable_chat_targets || []).map((target, index) => (
                <article
                  className={`user-ops-banner-card ${target.shown ? '' : 'muted'} ${canRepair && target.repairable ? 'repairable' : ''}`}
                  draggable={canRepair && target.repairable}
                  key={`warm:${target.user_id}:${index}`}
                  onDragStart={(event) => beginRepairDrag(event, target)}
                >
                  <BannerTargetAvatar avatarUrl={target.avatar_path ? avatarUrlByPath[target.avatar_path] : null} target={target} />
                  <div>
                    <b>{targetLabel(target)}</b>
                    <small>{target.email || target.user_id}</small>
                  </div>
                  <span className="user-ops-banner-state">{target.shown ? 'shown' : target.repairable ? 'repairable' : target.repair_block_reason || 'chat only'}</span>
                  {canRepair && target.repairable ? (
                    <button
                      className="user-ops-repair-button"
                      disabled={Boolean(repairingTargetId)}
                      onClick={() => repairBannerTarget(target, 'user_operations_button_chat_only_to_visible_now')}
                      type="button"
                    >
                      {repairingTargetId === target.user_id ? 'Repairing' : 'Repair'}
                    </button>
                  ) : null}
                </article>
              ))}

              {(bannerPanelRow.visibility.excluded_targets || []).length > 0 ? <h4>Excluded</h4> : null}
              {(bannerPanelRow.visibility.excluded_targets || []).map((target, index) => (
                <article className="user-ops-banner-card muted" key={`excluded:${target.user_id}:${index}`}>
                  <BannerTargetAvatar avatarUrl={target.avatar_path ? avatarUrlByPath[target.avatar_path] : null} target={target} />
                  <div>
                    <b>{targetLabel(target)}</b>
                    <small>{target.email || target.user_id}</small>
                  </div>
                  <span className="user-ops-banner-state">{target.state || 'excluded'}</span>
                </article>
              ))}
            </div>
          </div>
          <span className="user-ops-banner-panel-resize" onMouseDown={beginBannerPanelResize} />
        </aside>
      ) : null}
    </section>
  );
}
