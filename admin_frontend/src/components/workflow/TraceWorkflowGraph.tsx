// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/workflow/TraceWorkflowGraph.tsx
// ماموریت: ارائه workbench منعطف Trace Viewer برای مدل سازی، ذخیره و مانیتورینگ sandbox مسیرهای Collabra.

import {
  addEdge,
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnReconnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  Bell,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  Link,
  MousePointer2,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ErrorInfo,
  type ReactNode,
} from 'react';

type RoutineTelemetry = {
  inputPreview: string;
  latencyMs?: number;
  outputPreview: string;
  status: 'idle' | 'watch' | 'live' | 'error';
};

type RoutineNodeData = {
  actions: string[];
  description: string;
  events: string[];
  inputSchema: string;
  label: string;
  monitorSource: string;
  outputSchema: string;
  pinned: boolean;
  routineKey: string;
  section: string;
  settings: string;
  subtitle: string;
  telemetry: RoutineTelemetry;
  titleVisible: boolean;
  [key: string]: unknown;
};

type RoutineEdgeData = {
  actions: string[];
  events: string[];
  inputContract: string;
  label: string;
  latencyMs?: number;
  linkKind: string;
  outputContract: string;
  settings: string;
  status: 'idle' | 'watch' | 'live' | 'error';
  titleVisible: boolean;
  [key: string]: unknown;
};

type RoutineNode = Node<RoutineNodeData, 'routine'>;
type RoutineEdge = Edge<RoutineEdgeData, 'routineLink'>;

type TraceGraphState = {
  edges: RoutineEdge[];
  nodes: RoutineNode[];
};

type SavedScenario = TraceGraphState & {
  id: string;
  name: string;
  savedAt: string;
};

type ContextMenuState =
  | { kind: 'canvas'; flowX: number; flowY: number; left: number; top: number }
  | { edgeId: string; kind: 'edge'; left: number; top: number }
  | { kind: 'node'; left: number; nodeId: string; top: number };

type InspectorTarget =
  | { id: string; type: 'edge' }
  | { id: string; type: 'node' };

type InspectorTab = 'data' | 'events';

const TRACE_GRAPH_STORAGE_KEY = 'otmega.console.trace.workflow.graph.v4';
const TRACE_SCENARIOS_STORAGE_KEY = 'otmega.console.trace.workflow.scenarios.v1';
const LEGACY_TRACE_GRAPH_STORAGE_KEYS = [
  'otmega.console.trace.workflow.graph.v1',
  'otmega.console.trace.workflow.graph.v2',
  'otmega.console.trace.workflow.graph.v3',
];

const routineTemplates = [
  { key: 'frontend.chat_submit', label: 'Chat submit', section: 'frontend', subtitle: 'message compose/send event' },
  { key: 'backend.flask_api', label: 'Flask API', section: 'backend', subtitle: 'route handler' },
  { key: 'database.supabase_rpc', label: 'Supabase RPC', section: 'database', subtitle: 'RPC/query path' },
  { key: 'worker.wf1_async', label: 'WF1 async', section: 'worker', subtitle: 'async routine' },
  { key: 'storage.gcs_signed_url', label: 'GCS signed URL', section: 'storage', subtitle: 'bucket/object access' },
  { key: 'edge.cloudflare_db', label: 'Cloudflare DB Worker', section: 'cloudflare', subtitle: 'db.otmega.com worker' },
  { key: 'edge.cloudflare_files', label: 'Cloudflare Files Worker', section: 'cloudflare', subtitle: 'files.otmega.com worker' },
  { key: 'notify.internal_bus', label: 'Internal Notify Bus', section: 'notification', subtitle: 'in-app notification path' },
  { key: 'notify.os_push', label: 'OS Push Notification', section: 'notification', subtitle: 'browser / OS notification' },
];

const defaultNodes: RoutineNode[] = [
  createRoutineNode('input', { x: 0, y: 120 }, routineTemplates[0]),
  createRoutineNode('api', { x: 300, y: 120 }, routineTemplates[1]),
  createRoutineNode('db', { x: 600, y: 120 }, routineTemplates[2]),
  createRoutineNode('wf1', { x: 900, y: 120 }, routineTemplates[3]),
];

const defaultEdges: RoutineEdge[] = [
  createRoutineEdge('input-api', 'input', 'api', 'right-source', 'left-target', 'submit -> api'),
  createRoutineEdge('api-db', 'api', 'db', 'right-source', 'left-target', 'api -> rpc'),
  createRoutineEdge('api-wf1', 'api', 'wf1', 'bottom-source', 'left-target', 'enqueue async'),
];

const defaultGraph: TraceGraphState = {
  edges: defaultEdges,
  nodes: defaultNodes,
};

const handlePositions: Array<{ key: string; position: Position }> = [
  { key: 'top', position: Position.Top },
  { key: 'right', position: Position.Right },
  { key: 'bottom', position: Position.Bottom },
  { key: 'left', position: Position.Left },
];

function createRoutineNode(
  id: string,
  position: { x: number; y: number },
  routine: { key?: string; label: string; section?: string; subtitle?: string },
): RoutineNode {
  const section = routine.section || 'sandbox';
  return {
    id,
    position,
    type: 'routine',
    data: {
      actions: ['observe', 'compare latency'],
      description: `Sandbox monitor node for ${routine.label}.`,
      events: [`${section}.started`, `${section}.completed`],
      inputSchema: '{ "payload": "pending" }',
      label: routine.label,
      monitorSource: 'manual sandbox',
      outputSchema: '{ "result": "pending" }',
      pinned: false,
      routineKey: routine.key || `manual.${id}`,
      section,
      settings: '{ "sampleRate": 1, "readOnly": true }',
      subtitle: routine.subtitle || 'local monitor',
      telemetry: {
        inputPreview: 'not attached',
        outputPreview: 'not attached',
        status: 'watch',
      },
      titleVisible: true,
    },
  };
}

function createRoutineEdge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
  label = 'link',
): RoutineEdge {
  return withEdgeDefaults({
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'routineLink',
    data: {
      actions: ['trace handoff', 'measure transfer'],
      events: ['link.entered', 'link.exited'],
      inputContract: '{ "from": "source" }',
      label,
      linkKind: 'runtime path',
      outputContract: '{ "to": "target" }',
      settings: '{ "showTitle": true, "readOnly": true }',
      status: 'watch',
      titleVisible: true,
    },
  } as RoutineEdge);
}

function withEdgeDefaults(edge: RoutineEdge): RoutineEdge {
  return {
    ...edge,
    data: sanitizeEdgeData(edge.data),
    markerEnd: { type: MarkerType.ArrowClosed },
    reconnectable: true,
    type: 'routineLink',
  };
}

function sanitizeEdgeData(data?: Partial<RoutineEdgeData>): RoutineEdgeData {
  return {
    actions: Array.isArray(data?.actions) ? data.actions : ['trace handoff'],
    events: Array.isArray(data?.events) ? data.events : ['link.entered'],
    inputContract: typeof data?.inputContract === 'string' ? data.inputContract : '{ "from": "source" }',
    label: typeof data?.label === 'string' ? data.label : 'link',
    latencyMs: data?.latencyMs,
    linkKind: typeof data?.linkKind === 'string' ? data.linkKind : 'runtime path',
    outputContract: typeof data?.outputContract === 'string' ? data.outputContract : '{ "to": "target" }',
    settings: typeof data?.settings === 'string' ? data.settings : '{ "readOnly": true }',
    status: data?.status || 'watch',
    titleVisible: data?.titleVisible !== false,
  };
}

function sanitizeNode(node: Partial<RoutineNode>, index: number): RoutineNode {
  const data = (node.data || {}) as Partial<RoutineNodeData>;
  const position = node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y) ? node.position : { x: 180 * index, y: 120 };
  const label = String(data.label || `Routine ${index + 1}`);
  const section = typeof data.section === 'string' ? data.section : 'sandbox';

  return {
    id: String(node.id || `routine-${index + 1}`),
    position,
    selected: Boolean(node.selected),
    type: 'routine',
    data: {
      actions: Array.isArray(data.actions) ? data.actions : ['observe'],
      description: typeof data.description === 'string' ? data.description : `Sandbox monitor node for ${label}.`,
      events: Array.isArray(data.events) ? data.events : [`${section}.started`],
      inputSchema: typeof data.inputSchema === 'string' ? data.inputSchema : '{ "payload": "pending" }',
      label,
      monitorSource: typeof data.monitorSource === 'string' ? data.monitorSource : 'manual sandbox',
      outputSchema: typeof data.outputSchema === 'string' ? data.outputSchema : '{ "result": "pending" }',
      pinned: Boolean(data.pinned),
      routineKey: typeof data.routineKey === 'string' ? data.routineKey : `manual.${node.id || index}`,
      section,
      settings: typeof data.settings === 'string' ? data.settings : '{ "sampleRate": 1, "readOnly": true }',
      subtitle: typeof data.subtitle === 'string' ? data.subtitle : 'local monitor',
      telemetry: {
        inputPreview: data.telemetry?.inputPreview || 'not attached',
        latencyMs: data.telemetry?.latencyMs,
        outputPreview: data.telemetry?.outputPreview || 'not attached',
        status: data.telemetry?.status || 'watch',
      },
      titleVisible: data.titleVisible !== false,
    },
  };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    window.localStorage.removeItem(key);
    return fallback;
  }
}

function readStoredGraph(): TraceGraphState {
  const parsed = readJson<Partial<TraceGraphState>>(TRACE_GRAPH_STORAGE_KEY, defaultGraph);
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return defaultGraph;
  }
  return {
    edges: parsed.edges.map((edge) => withEdgeDefaults(edge)),
    nodes: parsed.nodes.map((node, index) => sanitizeNode(node, index)),
  };
}

function readSavedScenarios(): SavedScenario[] {
  const parsed = readJson<SavedScenario[]>(TRACE_SCENARIOS_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

function RoutineWorkflowNode({ data, selected }: NodeProps<RoutineNode>) {
  return (
    <div className={`trace-routine-node ${selected ? 'selected' : ''}`}>
      {handlePositions.map(({ key, position }) => (
        <Handle
          className={`trace-handle trace-handle-source trace-handle-${key}`}
          id={`${key}-source`}
          key={`${key}-source`}
          position={position}
          type="source"
        />
      ))}
      {handlePositions.map(({ key, position }) => (
        <Handle
          className={`trace-handle trace-handle-target trace-handle-${key}`}
          id={`${key}-target`}
          key={`${key}-target`}
          position={position}
          type="target"
        />
      ))}
      {data.titleVisible ? <strong>{data.label}</strong> : <strong className="trace-muted-title">untitled node</strong>}
      <small>{data.subtitle}</small>
      <span className={`trace-node-status status-${data.telemetry.status}`}>{data.telemetry.status}</span>
    </div>
  );
}

function RoutineWorkflowEdge(props: EdgeProps<RoutineEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath(props);
  const data = sanitizeEdgeData(props.data);
  return (
    <>
      <BaseEdge id={props.id} markerEnd={props.markerEnd} path={edgePath} style={props.style} />
      {data.titleVisible ? (
        <EdgeLabelRenderer>
          <button
            className={`trace-edge-label status-${data.status}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            type="button"
          >
            {data.label}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

class TraceWorkflowErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || 'Trace Viewer failed.' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Trace Viewer runtime error', error, info);
  }

  resetTraceGraph = () => {
    try {
      window.localStorage.removeItem(TRACE_GRAPH_STORAGE_KEY);
      LEGACY_TRACE_GRAPH_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      console.warn('Trace graph local storage reset failed.');
    }
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <article className="console-panel console-wide-panel">
        <span className="console-label">Trace Viewer</span>
        <strong>Trace workspace recovered from a local graph error.</strong>
        <p>{this.state.error}</p>
        <button className="console-icon-text-button" onClick={this.resetTraceGraph} type="button">
          <RotateCcw aria-hidden="true" size={16} />
          <span>Reset graph</span>
        </button>
      </article>
    );
  }
}

function TraceWorkflowWorkbench() {
  const initialGraph = useMemo(readStoredGraph, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<RoutineNode>(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RoutineEdge>(initialGraph.edges.map((edge) => withEdgeDefaults(edge)));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget | null>(null);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('data');
  const [scenarioName, setScenarioName] = useState('Collabra trace sandbox');
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>(() => readSavedScenarios());
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow<RoutineNode, RoutineEdge>();
  const nodeTypes = useMemo(() => ({ routine: RoutineWorkflowNode }), []);
  const edgeTypes = useMemo(() => ({ routineLink: RoutineWorkflowEdge }), []);
  const selectedNodeIds = useMemo(() => nodes.filter((node) => node.selected).map((node) => node.id), [nodes]);
  const selectedEdgeIds = useMemo(() => edges.filter((edge) => edge.selected).map((edge) => edge.id), [edges]);
  const activeNode = inspectorTarget?.type === 'node' ? nodes.find((node) => node.id === inspectorTarget.id) || null : null;
  const activeEdge = inspectorTarget?.type === 'edge' ? edges.find((edge) => edge.id === inspectorTarget.id) || null : null;

  useEffect(() => {
    try {
      window.localStorage.setItem(TRACE_GRAPH_STORAGE_KEY, JSON.stringify({ edges, nodes }));
    } catch {
      console.warn('Trace graph local storage write failed.');
    }
  }, [edges, nodes]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TRACE_SCENARIOS_STORAGE_KEY, JSON.stringify(savedScenarios));
    } catch {
      console.warn('Trace scenario local storage write failed.');
    }
  }, [savedScenarios]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((currentEdges) =>
        addEdge(
          createRoutineEdge(`edge-${Date.now()}`, connection.source || '', connection.target || '', connection.sourceHandle, connection.targetHandle, 'new link'),
          currentEdges,
        ),
      );
    },
    [setEdges],
  );

  const onReconnect = useCallback<OnReconnect<RoutineEdge>>(
    (oldEdge, newConnection) => {
      setEdges((currentEdges) => reconnectEdge(oldEdge, newConnection, currentEdges).map((edge) => withEdgeDefaults(edge)));
    },
    [setEdges],
  );

  function getCanvasCenter() {
    const rect = flowWrapperRef.current?.getBoundingClientRect();
    if (!rect) {
      return { x: 120, y: 120 };
    }
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }

  function addRoutineNode(routine: { key?: string; label: string; section?: string; subtitle?: string }, position?: { x: number; y: number }) {
    const nextPosition = position || getCanvasCenter();
    const nextNode = createRoutineNode(`routine-${Date.now()}`, nextPosition, routine);
    setNodes((currentNodes) => [...currentNodes.map((node) => ({ ...node, selected: false })), { ...nextNode, selected: true }]);
    setEdges((currentEdges) => currentEdges.map((edge) => ({ ...edge, selected: false })));
    setInspectorTarget({ id: nextNode.id, type: 'node' });
    setInspectorPinned(false);
    setContextMenu(null);
    setNewNodeLabel('');
  }

  function addCustomNodeFromContext() {
    const label = newNodeLabel.trim() || 'Manual routine';
    addRoutineNode(
      {
        label,
        section: 'manual',
        subtitle: 'sandbox box',
      },
      contextMenu?.kind === 'canvas' ? { x: contextMenu.flowX, y: contextMenu.flowY } : undefined,
    );
  }

  function duplicateNode(nodeId: string) {
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (!sourceNode) {
      return;
    }
    const nextNode: RoutineNode = {
      ...sourceNode,
      id: `routine-${Date.now()}`,
      position: { x: sourceNode.position.x + 44, y: sourceNode.position.y + 44 },
      selected: true,
      data: { ...sourceNode.data, label: `${sourceNode.data.label} copy` },
    };
    setNodes((currentNodes) => [...currentNodes.map((node) => ({ ...node, selected: false })), nextNode]);
    setInspectorTarget({ id: nextNode.id, type: 'node' });
    setContextMenu(null);
  }

  function deleteSelection() {
    if (!selectedNodeIds.length && !selectedEdgeIds.length && !inspectorTarget) {
      return;
    }
    const nodeIdsToDelete = new Set(selectedNodeIds);
    const edgeIdsToDelete = new Set(selectedEdgeIds);
    if (inspectorTarget?.type === 'node') {
      nodeIdsToDelete.add(inspectorTarget.id);
    }
    if (inspectorTarget?.type === 'edge') {
      edgeIdsToDelete.add(inspectorTarget.id);
    }
    setNodes((currentNodes) => currentNodes.filter((node) => !nodeIdsToDelete.has(node.id)));
    setEdges((currentEdges) =>
      currentEdges.filter((edge) => !edgeIdsToDelete.has(edge.id) && !nodeIdsToDelete.has(edge.source) && !nodeIdsToDelete.has(edge.target)),
    );
    setInspectorTarget(null);
    setContextMenu(null);
  }

  function resetGraph() {
    setNodes(defaultGraph.nodes);
    setEdges(defaultGraph.edges.map((edge) => withEdgeDefaults(edge)));
    setInspectorTarget(null);
    setContextMenu(null);
    try {
      window.localStorage.removeItem(TRACE_GRAPH_STORAGE_KEY);
      LEGACY_TRACE_GRAPH_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    } catch {
      console.warn('Trace graph local storage reset failed.');
    }
  }

  function updateNodeData(nodeId: string, partial: Partial<RoutineNodeData>) {
    setNodes((currentNodes) =>
      currentNodes.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...partial } } : node)),
    );
  }

  function updateEdgeData(edgeId: string, partial: Partial<RoutineEdgeData>) {
    setEdges((currentEdges) =>
      currentEdges.map((edge) => (edge.id === edgeId ? withEdgeDefaults({ ...edge, data: { ...edge.data, ...partial } }) : edge)),
    );
  }

  function saveScenario() {
    const name = scenarioName.trim() || 'Untitled trace scenario';
    const scenario: SavedScenario = {
      edges,
      id: `scenario-${Date.now()}`,
      name,
      nodes,
      savedAt: new Date().toISOString(),
    };
    setSavedScenarios((current) => [scenario, ...current.filter((item) => item.name !== name)].slice(0, 12));
    setSelectedScenarioId(scenario.id);
  }

  function loadScenario(event: ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value;
    setSelectedScenarioId(id);
    const scenario = savedScenarios.find((item) => item.id === id);
    if (!scenario) {
      return;
    }
    setNodes(scenario.nodes.map((node, index) => sanitizeNode(node, index)));
    setEdges(scenario.edges.map((edge) => withEdgeDefaults(edge)));
    setScenarioName(scenario.name);
    setInspectorTarget(null);
    setContextMenu(null);
  }

  function openInspector(target: InspectorTarget, pinned = false) {
    setInspectorTarget(target);
    setInspectorPinned(pinned);
    setInspectorTab('data');
    setContextMenu(null);
  }

  function toggleActiveTitle() {
    if (contextMenu?.kind === 'node') {
      const node = nodes.find((item) => item.id === contextMenu.nodeId);
      if (node) {
        updateNodeData(node.id, { titleVisible: !node.data.titleVisible });
      }
    }
    if (contextMenu?.kind === 'edge') {
      const edge = edges.find((item) => item.id === contextMenu.edgeId);
      if (edge) {
        updateEdgeData(edge.id, { titleVisible: !edge.data?.titleVisible });
      }
    }
    setContextMenu(null);
  }

  function pinActiveProperties() {
    if (contextMenu?.kind === 'node') {
      openInspector({ id: contextMenu.nodeId, type: 'node' }, true);
    }
    if (contextMenu?.kind === 'edge') {
      openInspector({ id: contextMenu.edgeId, type: 'edge' }, true);
    }
  }

  const activeTitle = activeNode?.data.label || activeEdge?.data?.label || 'Properties';

  return (
    <article className="console-trace-workbench">
      <div className="trace-workbench-topbar">
        <div className="trace-scenario-controls">
          <input aria-label="Scenario name" onChange={(event) => setScenarioName(event.target.value)} value={scenarioName} />
          <button className="console-icon-text-button" onClick={saveScenario} type="button">
            <Save aria-hidden="true" size={16} />
            <span>Save</span>
          </button>
          <select aria-label="Load scenario" onChange={loadScenario} value={selectedScenarioId}>
            <option value="">Load scenario</option>
            {savedScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        </div>
        <div className="trace-node-strip" aria-label="Boxes on canvas">
          {nodes.map((node) => (
            <button key={node.id} onClick={() => openInspector({ id: node.id, type: 'node' })} title={node.data.routineKey} type="button">
              {node.data.titleVisible ? node.data.label : 'hidden title'}
            </button>
          ))}
        </div>
      </div>

      <div className="console-graph-panel trace-canvas-panel" ref={flowWrapperRef}>
        <div className="console-graph-toolbar" aria-label="Trace workflow sandbox controls">
          <button aria-label="Add routine box" onClick={() => addRoutineNode(routineTemplates[0])} title="Add routine box" type="button">
            <Plus aria-hidden="true" size={16} />
          </button>
          <button aria-label="Delete selected workflow items" onClick={deleteSelection} title="Delete selected" type="button">
            <Trash2 aria-hidden="true" size={16} />
          </button>
          <button aria-label="Reset workflow sandbox" onClick={resetGraph} title="Reset sandbox" type="button">
            <RotateCcw aria-hidden="true" size={16} />
          </button>
        </div>
        <ReactFlow
          connectionMode={ConnectionMode.Loose}
          defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed }, reconnectable: true, type: 'routineLink' }}
          edges={edges}
          edgesReconnectable
          edgeTypes={edgeTypes}
          fitView
          nodes={nodes}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onEdgeClick={(_, edge) => openInspector({ id: edge.id, type: 'edge' })}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            setContextMenu({ edgeId: edge.id, kind: 'edge', left: event.clientX, top: event.clientY });
          }}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => {
            if (!inspectorPinned) {
              openInspector({ id: node.id, type: 'node' });
            }
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            setContextMenu({ kind: 'node', left: event.clientX, nodeId: node.id, top: event.clientY });
          }}
          onNodesChange={onNodesChange}
          onPaneClick={() => {
            setContextMenu(null);
            if (!inspectorPinned) {
              setInspectorTarget(null);
            }
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            setContextMenu({ flowX: flowPosition.x, flowY: flowPosition.y, kind: 'canvas', left: event.clientX, top: event.clientY });
            setNewNodeLabel('');
          }}
          onReconnect={onReconnect}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {contextMenu ? (
          <TraceContextMenu
            contextMenu={contextMenu}
            edges={edges}
            newNodeLabel={newNodeLabel}
            nodes={nodes}
            onAddCustom={addCustomNodeFromContext}
            onAddTemplate={addRoutineNode}
            onDelete={deleteSelection}
            onDuplicate={duplicateNode}
            onInspect={openInspector}
            onLabelChange={setNewNodeLabel}
            onPin={pinActiveProperties}
            onToggleTitle={toggleActiveTitle}
          />
        ) : null}
        {inspectorTarget && (activeNode || activeEdge) ? (
          <TracePropertiesPanel
            edge={activeEdge}
            node={activeNode}
            onClose={() => setInspectorTarget(null)}
            onPinToggle={() => setInspectorPinned((value) => !value)}
            onTabChange={setInspectorTab}
            onUpdateEdge={updateEdgeData}
            onUpdateNode={updateNodeData}
            pinned={inspectorPinned}
            tab={inspectorTab}
            title={activeTitle}
          />
        ) : null}
      </div>
    </article>
  );
}

type TraceContextMenuProps = {
  contextMenu: ContextMenuState;
  edges: RoutineEdge[];
  newNodeLabel: string;
  nodes: RoutineNode[];
  onAddCustom: () => void;
  onAddTemplate: (routine: { key?: string; label: string; section?: string; subtitle?: string }, position?: { x: number; y: number }) => void;
  onDelete: () => void;
  onDuplicate: (nodeId: string) => void;
  onInspect: (target: InspectorTarget, pinned?: boolean) => void;
  onLabelChange: (value: string) => void;
  onPin: () => void;
  onToggleTitle: () => void;
};

function TraceContextMenu({
  contextMenu,
  edges,
  newNodeLabel,
  nodes,
  onAddCustom,
  onAddTemplate,
  onDelete,
  onDuplicate,
  onInspect,
  onLabelChange,
  onPin,
  onToggleTitle,
}: TraceContextMenuProps) {
  const menuStyle = { left: contextMenu.left, top: contextMenu.top };
  const node = contextMenu.kind === 'node' ? nodes.find((item) => item.id === contextMenu.nodeId) : null;
  const edge = contextMenu.kind === 'edge' ? edges.find((item) => item.id === contextMenu.edgeId) : null;

  if (contextMenu.kind === 'canvas') {
    return (
      <form
        className="trace-context-menu trace-context-menu-wide"
        onSubmit={(event) => {
          event.preventDefault();
          onAddCustom();
        }}
        style={menuStyle}
      >
        <input autoFocus onChange={(event) => onLabelChange(event.target.value)} placeholder="Box caption" value={newNodeLabel} />
        <button type="submit">
          <Plus aria-hidden="true" size={14} />
          <span>Add custom box</span>
        </button>
        <div className="trace-menu-template-grid">
          {routineTemplates.map((template) => (
            <button
              key={template.key}
              onClick={() => onAddTemplate(template, { x: contextMenu.flowX, y: contextMenu.flowY })}
              type="button"
            >
              {template.label}
            </button>
          ))}
        </div>
      </form>
    );
  }

  return (
    <div className="trace-context-menu" style={menuStyle}>
      <strong>{node?.data.label || edge?.data?.label || 'Selection'}</strong>
      <button onClick={() => onInspect(contextMenu.kind === 'node' ? { id: contextMenu.nodeId, type: 'node' } : { id: contextMenu.edgeId, type: 'edge' })} type="button">
        <MousePointer2 aria-hidden="true" size={14} />
        <span>Properties</span>
      </button>
      <button onClick={onPin} type="button">
        <Pin aria-hidden="true" size={14} />
        <span>Pin properties</span>
      </button>
      <button onClick={onToggleTitle} type="button">
        {(node?.data.titleVisible ?? edge?.data?.titleVisible) ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
        <span>{(node?.data.titleVisible ?? edge?.data?.titleVisible) ? 'Hide title' : 'Show title'}</span>
      </button>
      {contextMenu.kind === 'node' ? (
        <button onClick={() => onDuplicate(contextMenu.nodeId)} type="button">
          <Copy aria-hidden="true" size={14} />
          <span>Duplicate node</span>
        </button>
      ) : null}
      <button onClick={onDelete} type="button">
        <Trash2 aria-hidden="true" size={14} />
        <span>Delete</span>
      </button>
    </div>
  );
}

type TracePropertiesPanelProps = {
  edge: RoutineEdge | null;
  node: RoutineNode | null;
  onClose: () => void;
  onPinToggle: () => void;
  onTabChange: (tab: InspectorTab) => void;
  onUpdateEdge: (edgeId: string, partial: Partial<RoutineEdgeData>) => void;
  onUpdateNode: (nodeId: string, partial: Partial<RoutineNodeData>) => void;
  pinned: boolean;
  tab: InspectorTab;
  title: string;
};

function TracePropertiesPanel({
  edge,
  node,
  onClose,
  onPinToggle,
  onTabChange,
  onUpdateEdge,
  onUpdateNode,
  pinned,
  tab,
  title,
}: TracePropertiesPanelProps) {
  const targetType = node ? 'node' : 'link';

  return (
    <aside className={`trace-properties-panel ${pinned ? 'pinned' : ''}`}>
      <header>
        <div>
          <span className="console-label">Properties</span>
          <strong>{title}</strong>
          <small>{targetType}</small>
        </div>
        <button aria-label="Pin properties" onClick={onPinToggle} title={pinned ? 'Unpin properties' : 'Pin properties'} type="button">
          {pinned ? <PinOff aria-hidden="true" size={16} /> : <Pin aria-hidden="true" size={16} />}
        </button>
        <button aria-label="Close properties" onClick={onClose} title="Close properties" type="button">
          <EyeOff aria-hidden="true" size={16} />
        </button>
      </header>
      <nav className="trace-properties-tabs">
        <button className={tab === 'data' ? 'active' : ''} onClick={() => onTabChange('data')} type="button">
          Data & Settings
        </button>
        <button className={tab === 'events' ? 'active' : ''} onClick={() => onTabChange('events')} type="button">
          Events / Routines / Actions
        </button>
      </nav>
      {node ? (
        <NodePropertiesBody node={node} onUpdate={(partial) => onUpdateNode(node.id, partial)} tab={tab} />
      ) : null}
      {edge ? (
        <EdgePropertiesBody edge={edge} onUpdate={(partial) => onUpdateEdge(edge.id, partial)} tab={tab} />
      ) : null}
    </aside>
  );
}

function NodePropertiesBody({ node, onUpdate, tab }: { node: RoutineNode; onUpdate: (partial: Partial<RoutineNodeData>) => void; tab: InspectorTab }) {
  if (tab === 'events') {
    return (
      <div className="trace-property-grid">
        <TraceTextArea label="Events" onChange={(value) => onUpdate({ events: linesToList(value) })} value={node.data.events.join('\n')} />
        <TraceTextArea label="Routines" onChange={(value) => onUpdate({ routineKey: value })} value={node.data.routineKey} />
        <TraceTextArea label="Actions" onChange={(value) => onUpdate({ actions: linesToList(value) })} value={node.data.actions.join('\n')} />
        <TraceLiveSummary telemetry={node.data.telemetry} />
      </div>
    );
  }

  return (
    <div className="trace-property-grid">
      <TraceInput label="Title" onChange={(value) => onUpdate({ label: value })} value={node.data.label} />
      <TraceInput label="Section" onChange={(value) => onUpdate({ section: value })} value={node.data.section} />
      <TraceInput label="Monitor source" onChange={(value) => onUpdate({ monitorSource: value })} value={node.data.monitorSource} />
      <TraceTextArea label="Description" onChange={(value) => onUpdate({ description: value })} value={node.data.description} />
      <TraceTextArea label="Input schema" onChange={(value) => onUpdate({ inputSchema: value })} value={node.data.inputSchema} />
      <TraceTextArea label="Output schema" onChange={(value) => onUpdate({ outputSchema: value })} value={node.data.outputSchema} />
      <TraceTextArea label="Settings" onChange={(value) => onUpdate({ settings: value })} value={node.data.settings} />
      <label className="trace-check-row">
        <input checked={node.data.titleVisible} onChange={(event) => onUpdate({ titleVisible: event.target.checked })} type="checkbox" />
        <span>Show node title</span>
      </label>
    </div>
  );
}

function EdgePropertiesBody({ edge, onUpdate, tab }: { edge: RoutineEdge; onUpdate: (partial: Partial<RoutineEdgeData>) => void; tab: InspectorTab }) {
  const data = sanitizeEdgeData(edge.data);
  if (tab === 'events') {
    return (
      <div className="trace-property-grid">
        <TraceTextArea label="Events" onChange={(value) => onUpdate({ events: linesToList(value) })} value={data.events.join('\n')} />
        <TraceTextArea label="Actions" onChange={(value) => onUpdate({ actions: linesToList(value) })} value={data.actions.join('\n')} />
        <TraceInput label="Status" onChange={(value) => onUpdate({ status: statusFromText(value) })} value={data.status} />
        <TraceInput label="Latency ms" onChange={(value) => onUpdate({ latencyMs: numberOrUndefined(value) })} value={String(data.latencyMs || '')} />
      </div>
    );
  }

  return (
    <div className="trace-property-grid">
      <TraceInput label="Link title" onChange={(value) => onUpdate({ label: value })} value={data.label} />
      <TraceInput label="Link kind" onChange={(value) => onUpdate({ linkKind: value })} value={data.linkKind} />
      <TraceTextArea label="Input contract" onChange={(value) => onUpdate({ inputContract: value })} value={data.inputContract} />
      <TraceTextArea label="Output contract" onChange={(value) => onUpdate({ outputContract: value })} value={data.outputContract} />
      <TraceTextArea label="Settings" onChange={(value) => onUpdate({ settings: value })} value={data.settings} />
      <label className="trace-check-row">
        <input checked={data.titleVisible} onChange={(event) => onUpdate({ titleVisible: event.target.checked })} type="checkbox" />
        <span>Show link title</span>
      </label>
    </div>
  );
}

function TraceInput({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label>
      <span>{label}</span>
      <input onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function TraceTextArea({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label>
      <span>{label}</span>
      <textarea onChange={(event) => onChange(event.target.value)} rows={3} value={value} />
    </label>
  );
}

function TraceLiveSummary({ telemetry }: { telemetry: RoutineTelemetry }) {
  return (
    <div className="trace-live-card">
      <Activity aria-hidden="true" size={16} />
      <strong>{telemetry.latencyMs ? `${telemetry.latencyMs} ms` : 'waiting'}</strong>
      <small>{telemetry.inputPreview} {'->'} {telemetry.outputPreview}</small>
      <Bell aria-hidden="true" size={16} />
      <small>Internal and OS notification probes are planned for Trace Bus.</small>
      <Cloud aria-hidden="true" size={16} />
      <small>Cloudflare Worker probes can be attached as monitored nodes.</small>
      <Link aria-hidden="true" size={16} />
      <small>Links keep their own contracts, settings, events and title visibility.</small>
    </div>
  );
}

function linesToList(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function statusFromText(value: string): RoutineEdgeData['status'] {
  return value === 'idle' || value === 'live' || value === 'error' ? value : 'watch';
}

function numberOrUndefined(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function TraceWorkflowGraph() {
  return (
    <TraceWorkflowErrorBoundary>
      <ReactFlowProvider>
        <TraceWorkflowWorkbench />
      </ReactFlowProvider>
    </TraceWorkflowErrorBoundary>
  );
}
