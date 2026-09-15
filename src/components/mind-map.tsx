export type MindMapNode = {
  label: string;
  children?: MindMapNode[];
};

function isMindMapNode(value: unknown): value is MindMapNode {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== "string" || !v.label.trim()) return false;
  if (v.children === undefined) return true;
  return Array.isArray(v.children) && v.children.every(isMindMapNode);
}

export function parseMindMap(raw: string): MindMapNode[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0 || !data.every(isMindMapNode)) return null;
  return data as MindMapNode[];
}

// A branch that itself fans out into multiple further-categorized branches
// (e.g. "Classification" -> "By Standardization" / "By Purpose" / "By
// Format", each with their own sub-items) needs real room to lay out side
// by side, so it spans the full grid row instead of sharing space with
// single-topic cards.
function isCategorical(node: MindMapNode): boolean {
  return (node.children ?? []).filter((c) => (c.children?.length ?? 0) > 0).length >= 2;
}

function Leaf({ label }: { label: string }) {
  return <span className="mindmap-chip">{label}</span>;
}

// A branch node: rendered as its own nested card when it has children,
// otherwise as a plain chip. Recurses so arbitrarily deep hierarchies
// (Classification -> Standardized -> Norm/Criterion) nest correctly.
function Branch({ node }: { node: MindMapNode }) {
  if (!node.children || node.children.length === 0) return <Leaf label={node.label} />;

  return (
    <div className="mindmap-subcard">
      <p className="mindmap-subcard-header">{node.label}</p>
      <div className="mindmap-tree">
        {node.children.map((child, i) => (
          <div className="mindmap-tree-item" key={i}>
            <Branch node={child} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CardBody({ node }: { node: MindMapNode }) {
  const children = node.children ?? [];
  if (children.length === 0) return null;

  const hasSubBranches = children.some((c) => (c.children?.length ?? 0) > 0);
  if (!hasSubBranches) {
    // A flat set of facts (e.g. Content / Criterion / Construct) reads best
    // as a simple chip row, not an artificially nested card.
    return (
      <div className="mindmap-chip-row">
        {children.map((c, i) => (
          <Leaf label={c.label} key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="mindmap-subgrid">
      {children.map((c, i) => (
        <Branch node={c} key={i} />
      ))}
    </div>
  );
}

export function MindMap({ data, accent }: { data: MindMapNode[]; accent: string }) {
  return (
    <div className="mindmap" style={{ "--mindmap-accent": accent } as React.CSSProperties}>
      <div className="mindmap-grid">
        {data.map((node, i) => (
          <div className={`mindmap-card${isCategorical(node) ? " mindmap-card--wide" : ""}`} key={i}>
            <p className="mindmap-card-header">{node.label}</p>
            <CardBody node={node} />
          </div>
        ))}
      </div>
    </div>
  );
}
