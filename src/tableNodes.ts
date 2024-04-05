import {
  TableNodes,
  TableNodesOptions,
  getCellAttrs,
  setCellAttrs,
} from './schema';

import { AttributeSpec } from 'prosemirror-model';

/**
 * This function creates a set of [node
 * specs](http://prosemirror.net/docs/ref/#model.SchemaSpec.nodes) for
 * `table`, `table_row`, and `table_cell` nodes types as used by this
 * module. The result can then be added to the set of nodes when
 * creating a schema.
 *
 * @public
 */

export function tableNodes(options: TableNodesOptions): TableNodes {
  const extraAttrs = options.cellAttributes || {};
  const cellAttrs: Record<string, AttributeSpec> = {
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
  };
  for (const prop in extraAttrs)
    cellAttrs[prop] = { default: extraAttrs[prop].default };

  return {
    table: {
      content: 'table_row+',
      tableRole: 'table',
      isolating: true,
      group: options.tableGroup,
      parseDOM: [{ tag: 'table' }],
      toDOM() {
        return ['table', ['tbody', 0]];
      },
    },
    table_row: {
      content: '(table_cell | table_header)*',
      tableRole: 'row',
      parseDOM: [{ tag: 'tr' }],
      toDOM() {
        return ['tr', 0];
      },
    },
    table_cell: {
      content: options.cellContent,
      attrs: cellAttrs,
      tableRole: 'cell',
      isolating: true,
      parseDOM: [
        { tag: 'td', getAttrs: (dom) => getCellAttrs(dom, extraAttrs) },
      ],
      toDOM(node) {
        return ['td', setCellAttrs(node, extraAttrs), 0];
      },
    },
    table_header: {
      content: options.cellContent,
      attrs: cellAttrs,
      tableRole: 'header_cell',
      isolating: true,
      parseDOM: [
        { tag: 'th', getAttrs: (dom) => getCellAttrs(dom, extraAttrs) },
      ],
      toDOM(node) {
        return ['th', setCellAttrs(node, extraAttrs), 0];
      },
    },
  };
}
