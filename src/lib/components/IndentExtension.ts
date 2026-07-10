import { Extension } from '@tiptap/core';

export interface IndentOptions {
	types: string[];
	minLevel: number;
	maxLevel: number;
}

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		indent: {
			/**
			 * Indent the selected node(s)
			 */
			indent: () => ReturnType;
			/**
			 * Outdent the selected node(s)
			 */
			outdent: () => ReturnType;
		};
	}
}

export const Indent = Extension.create<IndentOptions>({
	name: 'indent',

	addOptions() {
		return {
			types: ['paragraph', 'heading'],
			minLevel: 0,
			maxLevel: 8
		};
	},

	addGlobalAttributes() {
		return [
			{
				types: this.options.types,
				attributes: {
					indent: {
						default: 0,
						parseHTML: (element) => {
							const style = element.getAttribute('style') || '';
							const match = style.match(/margin-left:\s*(\d+)px/);
							if (match) {
								const margin = parseInt(match[1], 10);
								return Math.min(
									Math.max(Math.floor(margin / 24), this.options.minLevel),
									this.options.maxLevel
								);
							}
							const level = parseInt(element.getAttribute('data-indent') || '0', 10);
							return Math.min(Math.max(level, this.options.minLevel), this.options.maxLevel);
						},
						renderHTML: (attributes) => {
							if (!attributes.indent) {
								return {};
							}
							return {
								'data-indent': attributes.indent,
								style: `margin-left: ${attributes.indent * 24}px;`
							};
						}
					}
				}
			}
		];
	},

	addCommands() {
		return {
			indent: () => ({ tr, state, dispatch }: any) => {
				const { selection } = tr;
				const { from, to } = selection;

				let isChanged = false;

				state.doc.nodesBetween(from, to, (node: any, pos: number) => {
					if (this.options.types.includes(node.type.name)) {
						const currentIndent = node.attrs.indent || 0;
						const nextIndent = Math.min(
							currentIndent + 1,
							this.options.maxLevel
						);

						if (nextIndent !== currentIndent) {
							tr = tr.setNodeMarkup(pos, undefined, {
								...node.attrs,
								indent: nextIndent
							});
							isChanged = true;
						}
						return false;
					}
					return true;
				});

				if (isChanged && dispatch) {
					dispatch(tr);
				}
				return isChanged;
			},
			outdent: () => ({ tr, state, dispatch }: any) => {
				const { selection } = tr;
				const { from, to } = selection;

				let isChanged = false;

				state.doc.nodesBetween(from, to, (node: any, pos: number) => {
					if (this.options.types.includes(node.type.name)) {
						const currentIndent = node.attrs.indent || 0;
						const nextIndent = Math.max(
							currentIndent - 1,
							this.options.minLevel
						);

						if (nextIndent !== currentIndent) {
							tr = tr.setNodeMarkup(pos, undefined, {
								...node.attrs,
								indent: nextIndent
							});
							isChanged = true;
						}
						return false;
					}
					return true;
				});

				if (isChanged && dispatch) {
					dispatch(tr);
				}
				return isChanged;
			}
		};
	}
});
