// FILE: ~/otmega/otmega_app/console/admin_frontend/src/components/workflow/TraceWorkflowGraph.tsx
// ماموریت: نمایش گراف workflow روتین ها با React Flow و duration هر node.

import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const nodes: Node[] = [
  { id: 'input', position: { x: 0, y: 40 }, data: { label: 'Chat submit' } },
  { id: 'api', position: { x: 220, y: 40 }, data: { label: 'Flask API' } },
  { id: 'db', position: { x: 440, y: 40 }, data: { label: 'DB/RPC' } },
  { id: 'wf1', position: { x: 660, y: 40 }, data: { label: 'WF1 async' } },
];

const edges: Edge[] = [
  { id: 'input-api', source: 'input', target: 'api' },
  { id: 'api-db', source: 'api', target: 'db' },
  { id: 'api-wf1', source: 'api', target: 'wf1' },
];

export default function TraceWorkflowGraph() {
  return (
    <article className="console-graph-panel">
      <ReactFlow edges={edges} fitView nodes={nodes}>
        <Background />
        <Controls />
      </ReactFlow>
    </article>
  );
}
