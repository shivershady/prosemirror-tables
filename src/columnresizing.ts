import { Attrs, Node as ProsemirrorNode } from 'prosemirror-model';
import { CellAttrs, cellAround, pointsAtCell } from './util';
import {
  Decoration,
  DecorationSet,
  EditorView,
  NodeView,
} from 'prosemirror-view';
import { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state';
import {
  TableView,
  updateColumnsOnResize,
  updateRowsOnResize,
} from './tableview';

import { TableMap } from './tablemap';
import { tableNodeTypes } from './schema';

/**
 * @public
 */
export const columnResizingPluginKey = new PluginKey<ResizeState>(
  'tableColumnResizing',
);

/**
 * @public
 */
export type ColumnResizingOptions = {
  minSize?: number;
  cellMin?: number;
  lastColumnResizable?: boolean;
  View?: new (
    node: ProsemirrorNode,
    cellMin: number,
    view: EditorView,
  ) => NodeView;
};

/**
 * @public
 */
export type Dragging = { startPosition: number; startDimension: number };

/**
 * @public
 */
type typePositionCell = 'row' | 'col' | undefined;

/**
 * @public
 */
export function columnResizing({
  minSize = 5,
  cellMin = 25,
  View = TableView,
  lastColumnResizable = true,
}: ColumnResizingOptions = {}): Plugin {
  const plugin = new Plugin<ResizeState>({
    key: columnResizingPluginKey,
    state: {
      init(_, state) {
        plugin.spec!.props!.nodeViews![
          tableNodeTypes(state.schema).table.name
        ] = (node, view) => new View(node, cellMin, view);
        return new ResizeState(-1, false, undefined);
      },
      apply(tr, prev) {
        return prev.apply(tr);
      },
    },
    props: {
      attributes: (state): Record<string, string> => {
        const pluginState = columnResizingPluginKey.getState(state);
        return pluginState && pluginState.activeHandle > -1
          ? { class: `${pluginState.position}-resize-cursor` }
          : {};
      },

      handleDOMEvents: {
        mousemove: (view, event) => {
          handleMouseMove(view, event, minSize, cellMin, lastColumnResizable);
        },
        mouseleave: (view) => {
          handleMouseLeave(view);
        },
        mousedown: (view, event) => {
          handleMouseDown(view, event, cellMin);
        },
      },

      decorations: (state) => {
        const pluginState = columnResizingPluginKey.getState(state);
        if (pluginState && pluginState.activeHandle > -1) {
          return handleDecorations(
            state,
            pluginState.activeHandle,
            pluginState.position,
          );
        }
      },

      nodeViews: {},
    },
  });
  return plugin;
}

/**
 * @public
 */
export class ResizeState {
  constructor(
    public activeHandle: number,
    public dragging: Dragging | false,
    public position: typePositionCell,
  ) {}

  apply(tr: Transaction): ResizeState {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const state = this;
    const action = tr.getMeta(columnResizingPluginKey);

    if (action && action.setHandle != null)
      return new ResizeState(action.setHandle, false, action.setPosition);

    if (action && action.setDragging !== undefined)
      return new ResizeState(
        state.activeHandle,
        action.setDragging,
        action.setPosition,
      );

    if (state.activeHandle > -1 && tr.docChanged) {
      let handle = tr.mapping.map(state.activeHandle, -1);
      if (!pointsAtCell(tr.doc.resolve(handle))) {
        handle = -1;
      }
      return new ResizeState(handle, state.dragging, undefined);
    }
    return state;
  }
}

function handleMouseMove(
  view: EditorView,
  event: MouseEvent,
  minSize: number,
  cellMin: number,
  lastColumnResizable: boolean,
): void {
  const pluginState = columnResizingPluginKey.getState(view.state);
  if (!pluginState) return;

  if (!pluginState.dragging) {
    const target = domCellAround(event.target as HTMLElement);
    let cell = -1;
    let positionCell: typePositionCell;
    if (target) {
      const { left, right, top, bottom } = target.getBoundingClientRect();
      if (event.clientX - left <= minSize) {
        positionCell = 'col';
        cell = edgeCell(view, event, 'left', minSize);
      } else if (right - event.clientX <= minSize) {
        positionCell = 'col';
        cell = edgeCell(view, event, 'right', minSize);
      } else if (top - event.clientY >= -minSize) {
        positionCell = 'row';
        cell = edgeCell(view, event, 'top', minSize);
      } else if (event.clientY - bottom >= -minSize) {
        positionCell = 'row';
        cell = edgeCell(view, event, 'bottom', minSize);
      }
    }

    if (cell != pluginState.activeHandle) {
      if (!lastColumnResizable && cell !== -1) {
        const $cell = view.state.doc.resolve(cell);
        const table = $cell.node(-1);
        const map = TableMap.get(table);
        const tableStart = $cell.start(-1);
        const col =
          map.colCount($cell.pos - tableStart) +
          $cell.nodeAfter!.attrs.colspan -
          1;

        if (col == map.width - 1) {
          return;
        }
      }

      updateHandle(view, cell, positionCell);
    }
  }
}

function handleMouseLeave(view: EditorView): void {
  const pluginState = columnResizingPluginKey.getState(view.state);
  if (pluginState && pluginState.activeHandle > -1 && !pluginState.dragging)
    updateHandle(view, -1, undefined);
}

function handleMouseDown(
  view: EditorView,
  event: MouseEvent,
  cellMin: number,
): boolean {
  const win = view.dom.ownerDocument.defaultView ?? window;

  const pluginState = columnResizingPluginKey.getState(view.state);
  if (!pluginState || pluginState.activeHandle == -1 || pluginState.dragging)
    return false;

  const cell = view.state.doc.nodeAt(pluginState.activeHandle)!;
  const width = currentColWidth(view, pluginState.activeHandle, cell.attrs);
  const height = currentColHeight(view, pluginState.activeHandle, cell.attrs);
  const startCoord =
    pluginState.position === 'col' ? event.clientX : event.clientY;
  const startDimension = pluginState.position === 'col' ? width : height;
  view.dispatch(
    view.state.tr.setMeta(columnResizingPluginKey, {
      setDragging: { startPosition: startCoord, startDimension },
      setPosition: pluginState.position,
    }),
  );

  function finish(event: MouseEvent) {
    win.removeEventListener('mouseup', finish);
    win.removeEventListener('mousemove', move);
    const pluginState = columnResizingPluginKey.getState(view.state);
    if (pluginState?.dragging) {
      updateColumnWidth(
        view,
        pluginState.activeHandle,
        draggedDimension(
          pluginState.position,
          pluginState.dragging,
          event,
          cellMin,
        ),
      );
      view.dispatch(
        view.state.tr.setMeta(columnResizingPluginKey, {
          setDragging: null,
          setPosition: undefined,
        }),
      );
    }
  }

  function move(event: MouseEvent): void {
    if (!event.which) return finish(event);
    const pluginState = columnResizingPluginKey.getState(view.state);
    if (!pluginState) return;
    if (pluginState.dragging) {
      const dragged = draggedDimension(
        pluginState.position,
        pluginState.dragging,
        event,
        cellMin,
      );

      displayColumnDimension(
        view,
        pluginState.position,
        pluginState.activeHandle,
        dragged,
        cellMin,
      );
    }
  }

  win.addEventListener('mouseup', finish);
  win.addEventListener('mousemove', move);
  event.preventDefault();
  return true;
}

function currentColWidth(
  view: EditorView,
  cellPos: number,
  { colspan, colwidth }: Attrs,
): number {
  const width = colwidth && colwidth[colwidth.length - 1];
  if (width) return width;
  const dom = view.domAtPos(cellPos);
  const node = dom.node.childNodes[dom.offset] as HTMLElement;
  let domWidth = node.offsetWidth,
    parts = colspan;
  if (colwidth)
    for (let i = 0; i < colspan; i++)
      if (colwidth[i]) {
        domWidth -= colwidth[i];
        parts--;
      }
  return domWidth / parts;
}

function currentColHeight(
  view: EditorView,
  cellPos: number,
  { rowspan, rowheight }: Attrs,
): number {
  const height = rowheight && rowheight[rowheight.length - 1];
  if (height) return height;
  const dom = view.domAtPos(cellPos);
  const node = dom.node.childNodes[dom.offset] as HTMLElement;
  let domHeight = node.offsetHeight,
    parts = rowspan;
  if (rowheight)
    for (let i = 0; i < rowspan; i++)
      if (rowheight[i]) {
        domHeight -= rowheight[i];
        parts--;
      }
  return domHeight / parts;
}

function domCellAround(target: HTMLElement | null): HTMLElement | null {
  while (target && target.nodeName != 'TD' && target.nodeName != 'TH')
    target =
      target.classList && target.classList.contains('ProseMirror')
        ? null
        : (target.parentNode as HTMLElement);
  return target;
}

function edgeCell(
  view: EditorView,
  event: MouseEvent,
  side: 'left' | 'right' | 'top' | 'bottom',
  minSize: number,
): number {
  // posAtCoords returns inconsistent positions when cursor is moving
  // across a collapsed table border. Use an offset to adjust the
  // target viewport coordinates away from the table border.
  const offset = side == 'right' || side == 'bottom' ? -minSize : minSize;
  const found = view.posAtCoords({
    left: event.clientX + (side === 'left' || side === 'right' ? offset : 0),
    top: event.clientY + (side === 'top' || side === 'bottom' ? offset : 0),
  });
  if (!found) return -1;
  const { pos } = found;
  const $cell = cellAround(view.state.doc.resolve(pos));
  if (!$cell) return -1;
  if (side === 'right' || side === 'bottom') return $cell.pos;
  const map = TableMap.get($cell.node(-1)),
    start = $cell.start(-1);
  const index = map.map.indexOf($cell.pos - start);
  if (side === 'top') {
    return index < map.width ? -1 : start + map.map[index - map.width];
  } else {
    return index % map.width === 0 ? -1 : start + map.map[index - 1];
  }
}

function draggedDimension(
  position: typePositionCell,
  dragging: Dragging,
  event: MouseEvent,
  cellMin: number,
): number {
  const offset =
    position == 'col'
      ? event.clientX - dragging.startPosition
      : event.clientY - dragging.startPosition;
  return Math.max(cellMin, dragging.startDimension + offset);
}

function updateHandle(
  view: EditorView,
  value: number,
  positionCell: typePositionCell,
): void {
  view.dispatch(
    view.state.tr.setMeta(columnResizingPluginKey, {
      setHandle: value,
      setPosition: positionCell,
    }),
  );
}

function updateColumnWidth(
  view: EditorView,
  cell: number,
  width: number,
): void {
  const $cell = view.state.doc.resolve(cell);
  const table = $cell.node(-1),
    map = TableMap.get(table),
    start = $cell.start(-1);
  const col =
    map.colCount($cell.pos - start) + $cell.nodeAfter!.attrs.colspan - 1;
  const tr = view.state.tr;
  for (let row = 0; row < map.height; row++) {
    const mapIndex = row * map.width + col;
    // Rowspanning cell that has already been handled
    if (row && map.map[mapIndex] == map.map[mapIndex - map.width]) continue;
    const pos = map.map[mapIndex];
    const attrs = table.nodeAt(pos)!.attrs as CellAttrs;
    const index = attrs.colspan == 1 ? 0 : col - map.colCount(pos);
    if (attrs.colwidth && attrs.colwidth[index] == width) continue;
    const colwidth = attrs.colwidth
      ? attrs.colwidth.slice()
      : zeroes(attrs.colspan);
    colwidth[index] = width;
    tr.setNodeMarkup(start + pos, null, { ...attrs, colwidth: colwidth });
  }
  if (tr.docChanged) view.dispatch(tr);
}

function displayColumnDimension(
  view: EditorView,
  position: typePositionCell,
  cell: number,
  dragged: number,
  cellMin: number,
): void {
  const $cell = view.state.doc.resolve(cell);
  const table = $cell.node(-1),
    start = $cell.start(-1);
  const col =
    TableMap.get(table).colCount($cell.pos - start) +
    $cell.nodeAfter!.attrs.colspan -
    1;
  const row =
    TableMap.get(table).rowCount($cell.pos - start) +
    $cell.nodeAfter!.attrs.rowspan -
    1;

  let dom: Node | null = view.domAtPos($cell.start(-1)).node;
  while (dom && dom.nodeName != 'TABLE') {
    dom = dom.parentNode;
  }
  if (!dom) return;
  if (position === 'col') {
    updateColumnsOnResize(
      table,
      dom.firstChild as HTMLTableColElement,
      dom as HTMLTableElement,
      cellMin,
      col,
      dragged,
    );
  } else if (position === 'row') {
    updateRowsOnResize(
      table,
      dom.lastChild as HTMLTableSectionElement,
      dom as HTMLTableElement,
      cellMin,
      row,
      dragged,
    );
  }
}

function zeroes(n: number): 0[] {
  return Array(n).fill(0);
}

export function handleDecorations(
  state: EditorState,
  cell: number,
  position: typePositionCell,
): DecorationSet | undefined {
  const decorations = [];
  const $cell = state.doc.resolve(cell);
  const table = $cell.node(-1);
  if (!table) {
    return DecorationSet.empty;
  }
  const map = TableMap.get(table);
  if (position === 'col') {
    const start = $cell.start(-1);
    const col =
      map.colCount($cell.pos - start) + $cell.nodeAfter!.attrs.colspan;
    for (let row = 0; row < map.height; row++) {
      const index = col + row * map.width - 1;
      // For positions that have either a different cell or the end
      // of the table to their right, and either the top of the table or
      // a different cell above them, add a decoration
      if (
        (col == map.width || map.map[index] != map.map[index + 1]) &&
        (row == 0 || map.map[index] != map.map[index - map.width])
      ) {
        const cellPos = map.map[index];
        const pos = start + cellPos + table.nodeAt(cellPos)!.nodeSize - 1;
        const dom = document.createElement('div');
        dom.className = 'column-resize-handle';
        decorations.push(Decoration.widget(pos, dom));
      }
    }
    return DecorationSet.create(state.doc, decorations);
  } else if (position === 'row') {
    const start = $cell.start(-1);
    const row =
      map.rowCount($cell.pos - start) + $cell.nodeAfter!.attrs.rowspan;
    for (let col = 0; col < map.width; col++) {
      const index = (row - 1) * map.width + col;
      if (
        (row == map.height || map.map[index] != map.map[index + map.width]) &&
        (col == 0 || map.map[index] != map.map[index - 1])
      ) {
        const cellPos = map.map[index];
        const pos = start + cellPos + table.nodeAt(cellPos)!.nodeSize - 1;
        const dom = document.createElement('div');
        dom.className = 'row-resize-handle';
        decorations.push(Decoration.widget(pos, dom));
      }
    }
    return DecorationSet.create(state.doc, decorations);
  }
}
