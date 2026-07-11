// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/monitoring/OperationalResources.tsx
// ماموریت: نمایش کارت های مانیتورینگ زنده زیرساخت Collabra در داشبورد کنسول.

import {
  Activity,
  Cloud,
  Database,
  ExternalLink,
  Globe2,
  HardDrive,
  Info,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { fetchOperationalResources, type OperationalResource } from '../../api/consoleApi';

const groupIcons = {
  Compute: Server,
  Data: Database,
  Edge: Globe2,
  Frontend: Cloud,
  Storage: HardDrive,
};

type OperationalResourcesProps = {
  enabled: boolean;
};

function statusLabel(status: OperationalResource['status']): string {
  if (status === 'ok') {
    return 'ok';
  }
  if (status === 'warn') {
    return 'watch';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'unknown';
}

function statusIcon(status: OperationalResource['status']) {
  return status === 'error' ? TriangleAlert : ShieldCheck;
}

export default function OperationalResources({ enabled }: OperationalResourcesProps) {
  const [resources, setResources] = useState<OperationalResource[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);

  async function refreshResources() {
    if (!enabled) {
      return;
    }
    setLoading(true);
    try {
      const payload = await fetchOperationalResources();
      setResources(payload.resources);
      setUpdatedAt(payload.timestamp);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Operational resources probe failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshResources();
    const interval = window.setInterval(refreshResources, 30000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  const totals = useMemo(() => {
    return resources.reduce(
      (current, resource) => {
        current[resource.status] += 1;
        return current;
      },
      { error: 0, ok: 0, unknown: 0, warn: 0 },
    );
  }, [resources]);

  const selectedResource = useMemo(() => {
    return resources.find((resource) => resource.id === selectedResourceId) || null;
  }, [resources, selectedResourceId]);

  useEffect(() => {
    if (selectedResourceId && !selectedResource) {
      setSelectedResourceId(null);
    }
  }, [selectedResource, selectedResourceId]);

  if (!enabled) {
    return (
      <article className="console-panel console-wide-panel">
        <span className="console-label">Infrastructure</span>
        <strong>Operational resources need console.view_operational_status capability.</strong>
        <p>This dashboard section remains hidden for non-admin operators.</p>
      </article>
    );
  }

  return (
    <section className="console-ops-section" aria-label="Operational resources">
      <div className="console-section-heading">
        <div>
          <h3>Live Infrastructure</h3>
          <p>Database, storage, hosting, edge workers and service links for Collabra operations.</p>
        </div>
        <button className="console-icon-text-button" disabled={loading} onClick={refreshResources} type="button">
          <RefreshCw aria-hidden="true" className={loading ? 'spin' : undefined} size={17} />
          <span>{loading ? 'Refreshing' : 'Refresh'}</span>
        </button>
      </div>

      <div className="console-ops-summary">
        <span className="status-ok">{totals.ok} ok</span>
        <span className="status-warn">{totals.warn} watch</span>
        <span className="status-error">{totals.error} error</span>
        <span>{totals.unknown} unknown</span>
        {updatedAt ? <small>Last probe: {new Date(updatedAt).toLocaleTimeString()}</small> : null}
      </div>

      {error ? <div className="console-error">{error}</div> : null}

      <div className="console-resource-grid">
        {resources.map((resource) => {
          const GroupIcon = groupIcons[resource.group as keyof typeof groupIcons] || Activity;
          const StatusIcon = statusIcon(resource.status);
          return (
            <article className={`console-resource-card status-${resource.status}`} key={resource.id}>
              <div className="console-resource-head">
                <span className="console-resource-icon">
                  <GroupIcon aria-hidden="true" size={20} />
                </span>
                <div>
                  <strong>{resource.name}</strong>
                  <small>{resource.kind}</small>
                </div>
                <span className="console-resource-status">
                  <StatusIcon aria-hidden="true" size={15} />
                  {statusLabel(resource.status)}
                </span>
              </div>
              <p>{resource.summary}</p>
              <div className="console-resource-metrics">
                {resource.latency_ms !== null ? (
                  <span>
                    <b>{resource.latency_ms} ms</b>
                    <small>latency</small>
                  </span>
                ) : null}
                {resource.metrics.map((metric) => (
                  <span className={`metric-${metric.state}`} key={`${resource.id}-${metric.label}`}>
                    <b>{metric.value}</b>
                    <small>{metric.label}</small>
                  </span>
                ))}
              </div>
              <div className="console-resource-links">
                {resource.links.map((link) => (
                  <a href={link.url} key={`${resource.id}-${link.label}`} rel="noreferrer" target="_blank">
                    <ExternalLink aria-hidden="true" size={14} />
                    <span>{link.label}</span>
                  </a>
                ))}
              </div>
              <button
                className="console-resource-details-button"
                onClick={() => setSelectedResourceId(resource.id)}
                type="button"
              >
                <Info aria-hidden="true" size={15} />
                <span>Details</span>
              </button>
            </article>
          );
        })}
      </div>

      {selectedResource ? (
        <article className={`console-resource-detail status-${selectedResource.status}`}>
          <div className="console-resource-detail-head">
            <div>
              <span className="console-label">Resource Detail</span>
              <h4>{selectedResource.name}</h4>
              <p>{selectedResource.kind}</p>
            </div>
            <button
              aria-label="Close resource detail"
              className="console-icon-button"
              onClick={() => setSelectedResourceId(null)}
              type="button"
            >
              <X aria-hidden="true" size={17} />
            </button>
          </div>

          <div className="console-resource-detail-grid">
            <div className="console-resource-detail-summary">
              <span className={`console-resource-status status-${selectedResource.status}`}>
                {statusLabel(selectedResource.status)}
              </span>
              <p>{selectedResource.summary}</p>
              <dl>
                <div>
                  <dt>Resource ID</dt>
                  <dd>{selectedResource.id}</dd>
                </div>
                <div>
                  <dt>Group</dt>
                  <dd>{selectedResource.group}</dd>
                </div>
                <div>
                  <dt>Checked at</dt>
                  <dd>{new Date(selectedResource.checked_at).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Latency</dt>
                  <dd>{selectedResource.latency_ms === null ? 'not reported' : `${selectedResource.latency_ms} ms`}</dd>
                </div>
                <div>
                  <dt>Primary URL</dt>
                  <dd>{selectedResource.primary_url || 'not reported'}</dd>
                </div>
                <div>
                  <dt>Console URL</dt>
                  <dd>{selectedResource.console_url || 'not reported'}</dd>
                </div>
              </dl>
            </div>

            <div className="console-resource-detail-metrics">
              <span className="console-label">Metrics</span>
              <div>
                {selectedResource.metrics.map((metric) => (
                  <span className={`metric-${metric.state}`} key={`${selectedResource.id}-detail-${metric.label}`}>
                    <b>{metric.value}</b>
                    <small>{metric.label}</small>
                  </span>
                ))}
              </div>
            </div>

            <div className="console-resource-detail-links">
              <span className="console-label">Links</span>
              <div>
                {selectedResource.links.map((link) => (
                  <a href={link.url} key={`${selectedResource.id}-detail-${link.label}`} rel="noreferrer" target="_blank">
                    <ExternalLink aria-hidden="true" size={14} />
                    <span>{link.label}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </article>
      ) : null}
    </section>
  );
}
