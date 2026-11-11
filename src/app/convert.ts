// Design file ⇄ React Flow nodes and edges. The original objects are kept so that loading and saving
// an unchanged design writes the same bytes (key order, optional fields, ids).
import type { Edge, Node } from '@xyflow/react';
import { edgeId, type Design, type DesignEdge, type DesignNode } from '../schema/design.ts';

export type NodeData = { node: DesignNode };
export type EdgeData = { edge: DesignEdge };
export type SdNode = Node<NodeData, 'component'>;
export type SdEdge = Edge<EdgeData, 'flow'>;

export function toFlow(d: Design): { nodes: SdNode[]; edges: SdEdge[] } {
  return {
    nodes: d.nodes.map((n) => ({ id: n.id, type: 'component', position: { x: n.pos[0], y: n.pos[1] }, data: { node: n } })),
    edges: d.edges.map((e) => ({ id: edgeId(e), type: 'flow', source: e.from, target: e.to, data: { edge: e } })),
  };
}

export function toDesign(doc: Design, nodes: SdNode[], edges: SdEdge[]): Design {
  return {
    ...doc,
    nodes: nodes.map((n) => {
      const pos: [number, number] = [Math.round(n.position.x), Math.round(n.position.y)];
      const same = n.data.node.pos[0] === pos[0] && n.data.node.pos[1] === pos[1];
      return same ? n.data.node : { ...n.data.node, pos };
    }),
    edges: edges.map((e) => e.data!.edge),
  };
}

/** A new id for a node of `kind` that is not taken yet: service, service2, service3 … */
export function freshId(kind: string, taken: Set<string>): string {
  if (!taken.has(kind)) return kind;
  for (let i = 2; ; i++) if (!taken.has(`${kind}${i}`)) return `${kind}${i}`;
}
