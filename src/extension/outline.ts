import { config } from './config';
import { commands, DocumentSymbol, ExtensionContext, TextDocument, Uri, WebviewView, WebviewViewProvider, window, Range, Selection, Position, Diagnostic, DiagnosticSeverity, CancellationTokenSource, SymbolKind } from 'vscode';
import { Msg, UpdateMsg, Op, UpdateOp, DeleteOp, InsertOp, SymbolNode, MoveOp, PinStatus, FocusMsg, Sortby } from '../common';
import { WorkspaceSymbols } from './workspace';
import { RegionProvider } from './region';
import { deepClone } from '../utils';

/**
 * Initialization options for the outline view.
 */
interface OutlineViewInit {
	context: ExtensionContext;
	workspaceSymbols?: WorkspaceSymbols;
	regionProvider?: RegionProvider;
	initialSearch?: boolean;
	sortBy?: Sortby;
}

/**
 * Provides the outline view.
 */
export class OutlineView implements WebviewViewProvider {

	/** The webview View of the outline. */
	private view: WebviewView | undefined;

	/** The uri of the directory containing this extension. */
	private extensionUri: Uri;

	public outlineTree: OutlineTree | undefined;

	private focusing: Set<SymbolNode> = new Set();

	private prevSelections: Selection[] = [];

	private inView: Set<SymbolNode> = new Set();

	private hasDiagnostic: Set<SymbolNode> = new Set();

	private pinStatus: PinStatus = PinStatus.unpinned;

	private workspaceSymbols: WorkspaceSymbols | undefined;

	private regionProvider: RegionProvider | undefined;

	private initialSearch: boolean;

	private sortby: Sortby = Sortby.position;

	private context: ExtensionContext;

	private toggleHiddenNotCommentSymbol: boolean

	constructor(init: OutlineViewInit) {
		this.extensionUri = init.context.extensionUri;
		this.context = init.context;
		this.workspaceSymbols = init.workspaceSymbols;
		this.regionProvider = init.regionProvider;
		this.initialSearch = init.initialSearch || false;
		this.sortby = init.sortBy || Sortby.position;
		this.toggleHiddenNotCommentSymbol = this.context.globalState.get('toggleHiddenNotCommentSymbol', false);

		this.handleStateChange()

		commands.registerCommand('outline-map.toggleHiddenNotCommentSymbolNotifyStateChange', this.handleStateChange.bind(this));



	}

	handleStateChange() {
		// 初始化时也根据当前状态设置
		const currentState = this.context.globalState.get('toggleHiddenNotCommentSymbol', false);

		this.toggleHiddenNotCommentSymbol = currentState;
		if (this.outlineTree) {
			this.outlineTree.toggleHiddenNotCommentSymbol = currentState;
			// this.outlineTree.updateSymbols();
		}
		this.build()

	}

	pin(pinStatus: PinStatus) {
		this.pinStatus = pinStatus;
	}

	sort(sortBy: Sortby) {
		this.sortby = sortBy;
		this.clear('Re-sorting the outline...');
		this.update(window.activeTextEditor?.document || window.visibleTextEditors[0].document);
	}

	resolveWebviewView(webviewView: WebviewView): void | Thenable<void> {
		this.view = webviewView;

		this.view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this.extensionUri,
			],
		};

		this.render();
		setTimeout(() => {
			this.build();
		}, 1000);
		this.view.onDidChangeVisibility(() => {
			if (this.view?.visible && window.activeTextEditor) {
				this.build();
			}
			if (!this.view?.visible) {
				this.outlineTree = undefined;
				this.inView.clear();
				this.focusing.clear();
				this.prevSelections = [];
			}
		});
		this.view.webview.onDidReceiveMessage((msg: Msg) => {
			switch (msg.type) {
				case 'goto': {
					const res = commands.executeCommand(
						'editor.action.goToLocations',
						window.activeTextEditor?.document.uri,
						// vscode doesn't seem to recognize `msg.data.position` as a `Position` object
						// so we have to create a new one
						new Position(
							msg.data.position.line,
							msg.data.position.character,
						), [], 'goto', ''
					);
					if (config.findRefEnabled()) {
						res.then(() => {
							commands.executeCommand(config.findRefUseFindImpl() ?
								'references-view.findImplementations' : 'references-view.findReferences').then(ref => {
									config.debug() && console.log(ref);
								});
						});
					}
				}
				case 'expand': {
					//  判断是否要折叠, 如果要的话, 就把代码中相应的部分折叠
					const editor = window.activeTextEditor;
					if (!editor) {
						console.log('No active text editor');
						return;
					}
					const { position, expand } = msg.data;
					const start = new Position(position.line, 0);
					editor.selection = new Selection(start, start);
					if (expand == undefined) {
						return
					}
					if (expand) {
						// console.log(position,"unfold");

						commands.executeCommand('editor.unfold', position);
					} else {
						// console.log(position,"fold");
						commands.executeCommand('editor.fold', position);
					}



				}
			}
		});
	}

	build() {
		this.update(window.activeTextEditor?.document || window.visibleTextEditors[0].document);
		this.postMessage({
			type: 'config',
			data: {
				color: config.color(),
				depth: config.defaultMaxDepth(),
				debug: config.debug(),
			},
		});
		if (this.initialSearch) {
			this.postMessage({
				type: 'focus',
				toggle: false,
			} as FocusMsg);
		}
	}

	/**
	 * Sends a message to the webview.
	 * @param message The message to send to the webview, must contain a type property.
	*/
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	postMessage(message: Msg) {
		this.view?.webview.postMessage(message);
	}

	/**
	 * Focuses the outline on the current selection.
	 */
	focus(selections: readonly Selection[]) {
		// return
		if (!this.outlineTree) return;
		if (this.pinStatus === PinStatus.frozen) return;
		// check if the selection has changed
		const changed =
			selections.length !== this.prevSelections.length ||
			selections.some((selection, i) => {
				return (
					selection.start.line !== this.prevSelections[i].start.line ||
					selection.end.line !== this.prevSelections[i].end.line
				);
			});

		if (!changed) {
			return;
		}
		this.prevSelections = selections.slice();

		const Ops: UpdateOp[] = [];
		// 1. unfocus all nodes
		for (const node of this.focusing) {
			node.focus = false;
		}

		// 2. focus the nodes in the selection
		for (const selection of selections) {

			const { inRange, closest } = this.outlineTree.findNodesIn(selection);

			inRange?.forEach((n) => {
				n.focus = true;
				this.focusing.add(n);
			});

			// If no node is focused, focus the most closest node
			// To avoid losing focus when the cursor is between two nodes
			if (inRange.length === 0 && closest) {
				closest.focus = true;
				this.focusing.add(closest);
			}
		}

		// 3. send the update message && remove the unfocused nodes
		for (const node of this.focusing) {
			Ops.push({
				type: 'update',
				selector: node.selector.join(' >.outline-children> '),
				property: 'focus',
				value: node.focus,
			} as UpdateOp);
			if (!node.focus) {
				this.focusing.delete(node);
			}
		}

		this.postMessage({
			type: 'update',
			data: {
				patches: Ops,
			},
		} as UpdateMsg);
	}

	updateViewPort(range: Range) {
		if (!this.outlineTree) return;
		if (this.pinStatus === PinStatus.frozen) return;
		const Ops: UpdateOp[] = [];
		// 1. remove all nodes in the viewport
		for (const node of this.inView) {
			node.inView = false;
			if (config.expand() !== 'manual') {
				node.expand = false;
			}
		}

		// 2. add the nodes in the viewport
		const { inRange, involves } = this.outlineTree.findNodesIn(range);
		// 2.1 Update the nodes in the viewport (change background color)
		inRange.forEach((node) => {
			node.inView = true;
			if (!this.inView.has(node)) {
				this.inView.add(node);
			}
		});
		// 2.2 Update the nodes that overlaps with the viewport (expand the node)
		if (this.pinStatus === PinStatus.unpinned) {
			if (config.expand() === 'viewport') {
				inRange.forEach((node) => {
					node.expand = true;
				});
				involves.forEach((node) => {
					node.expand = true;
					if (!this.inView.has(node)) {
						this.inView.add(node);
					}
				});
			}
			else if (config.expand() === 'cursor' && window.activeTextEditor?.selection) {
				const { inRange: cursorInRange, involves: cursorInvolves } = this.outlineTree.findNodesIn(window.activeTextEditor.selection);
				cursorInRange.forEach((node) => {
					node.expand = true;
				});
				cursorInvolves.forEach((node) => {
					node.expand = true;
					if (!this.inView.has(node)) {
						this.inView.add(node);
					}
				});
			}
		}

		// 3. send the update message && remove the nodes out of the viewport
		for (const node of this.inView) {
			Ops.push({
				type: 'update',
				selector: node.selector.join(' >.outline-children> '),
				property: 'inview',
				value: node.inView,
			} as UpdateOp);
			if (this.pinStatus === PinStatus.unpinned && config.expand() !== 'manual') {
				Ops.push({
					type: 'update',
					selector: node.selector.join(' >.outline-children> '),
					property: 'expand',
					value: node.expand,
				} as UpdateOp);
			}
			if (!node.inView && !node.expand) {
				this.inView.delete(node);
			}
		}

		this.postMessage({
			type: 'update',
			data: {
				patches: Ops,
			},
		} as UpdateMsg);
	}

	updateDiagnostics(diagnostics: Diagnostic[]) {
		if (!this.outlineTree) return;
		const Ops: UpdateOp[] = [];
		// 1. reset all nodes
		for (const node of this.hasDiagnostic) {
			node.diagnosticStats.clear();
		}

		// 2. remove diagnostics that is not 'error' or 'warning'
		//    sort the diagnostics by the start line
		diagnostics = diagnostics
			.filter((diagnostic) => {
				return diagnostic.severity === DiagnosticSeverity.Error || diagnostic.severity === DiagnosticSeverity.Warning;
			})
			.sort((a, b) => {
				return a.range.start.line - b.range.start.line;
			});

		let i = 0;

		// 3. recursively find the nodes that contains the diagnostics
		const findNodes = (node: SymbolNode) => {
			if (i >= diagnostics.length) return node.diagnosticStats.getStat();
			const diagnostic = diagnostics[i];
			if (diagnostic.range.start.line > node.range.end.line) return node.diagnosticStats.getStat();
			if (diagnostic.range.end.line < node.range.start.line) return node.diagnosticStats.getStat();
			// the current diagnostic is in the node or in the child nodes
			for (const child of node.children) {
				const diagnosticInChild = findNodes(child);
				if (diagnosticInChild.type !== 'none') {
					// the current diagnostic is in the child node
					node.diagnosticStats.add(diagnosticInChild.type, true);
					this.hasDiagnostic.add(node);
					// skip the other child nodes and search for the next diagnostic
					i++;
					findNodes(node);
					return node.diagnosticStats.getStat();
				}
			}
			// the current diagnostic is in the node
			node.diagnosticStats.add(diagnostic.severity === DiagnosticSeverity.Error ? 'error' : 'warning', false);
			this.hasDiagnostic.add(node);
			i++;
			findNodes(node);
			return node.diagnosticStats.getStat();
		};
		for (const node of this.outlineTree.getNodes()) {
			findNodes(node);
		}
		// 4. send the update message && remove the nodes that has no diagnostics
		for (const node of this.hasDiagnostic) {
			const diagnostic = node.diagnosticStats.getStat();
			Ops.push({
				type: 'update',
				selector: node.selector.join(' >.outline-children> '),
				property: 'diagnostictype',
				value: diagnostic.type,
			} as UpdateOp,
				{
					type: 'update',
					selector: node.selector.join(' >.outline-children> '),
					property: 'diagnosticcount',
					value: diagnostic.count,
				} as UpdateOp);
			if (diagnostic.type === 'none') {
				this.hasDiagnostic.delete(node);
			}
		}

		this.postMessage({
			type: 'update',
			data: {
				patches: Ops,
			},
		} as UpdateMsg);

	}

	/**
	 * Renders the webview.
	 */
	private render() {
		if (!this.view) {
			return;
		}
		const getAssetUri = (path: string) => {
			return this.view?.webview.asWebviewUri(Uri.joinPath(this.extensionUri, ...path.split('/')));
		};

		this.view.webview.html = /*html*/`
			<!DOCTYPE html>
			<html>
			  <head>
				<meta charset="UTF-8">
				<!-- <link href="${getAssetUri('node_modules/@vscode/codicons/dist/codicon.css')}" rel="stylesheet"> -->
				<!-- <link href="${getAssetUri('out/webview/style.css')}" rel="stylesheet"> -->
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<!-- <script type="module" src="${getAssetUri('node_modules/@vscode/webview-ui-toolkit/dist/toolkit.min.js')}"></script> -->
				<title>Outline Map</title>
				<style>
					:not(.codicon) {
						font-family: ${config.customFont() || 'system-ui'}
					}
					${config.customCSS()}
				</style>
				<style id="color-style"></style>
			  </head>
			  <body>
				<script type="module" src="${getAssetUri('out/webview/index.js')}"></script>
			  </body>
			</html>`;
	}

	/**
	 * Check if the document should be handled by the outline view.
	 * @param document 
	 * @returns 
	 */
	isValidDocument(document: TextDocument | undefined) {
		// Note: Some documents like output and vscode settings are not supported 
		// by the outline view and may interrupt the outline view.
		// Some documents don't have to be 'file', and their symbolic information may also be supported, 
		// so we shouldn't use 'file' to filter them, and there may be some schemes that need to be overlooked
		const ignoreScheme = [
			'output',
			'vscode-scm',
			'walkThroughSnippet',
		];
		const scheme = document?.uri.scheme;
		// console.log('scheme:', scheme);
		if (!document || !scheme) {
			return false;
		}
		for (const s of ignoreScheme) {
			if (scheme.startsWith(s)) {
				return false;
			}
		}
		return true;
	}

	update(textDocument: TextDocument | undefined) {
		if (textDocument === undefined) { // No active editor
			this.clear('The active editor cannot provide outline information.');
			return;
		}
		if (!this.isValidDocument(textDocument)) { // Switched to a non-supported document like output
			return;
		}

		const newOutlineTree = new OutlineTree(textDocument, this.regionProvider, this.sortby);
		newOutlineTree.toggleHiddenNotCommentSymbol = this.toggleHiddenNotCommentSymbol
		newOutlineTree.updateSymbols().then(() => {
			const newNodes = newOutlineTree.getNodes();
			if (!newNodes || newNodes.length === 0) {
				this.clear(`No symbols found in document '${textDocument.fileName}'.`);
				return;
			}
			this.workspaceSymbols?.updateSymbol(newNodes, textDocument.uri);
			const patcher = new Patcher(this.outlineTree?.getNodes() || [], newNodes);
			const ops = patcher.getOps();
			this.postMessage({
				type: 'update',
				data: {
					patches: ops,
				},
			} as UpdateMsg);
			this.outlineTree = newOutlineTree;
		});
	}

	/**
	 * Clears the outline view and send a clear message (The active editor does not provide outline/Can not find outline in the active editor).
	 */
	clear(description?: string) {
		this.outlineTree = undefined;
		this.inView.clear();
		this.focusing.clear();
		this.prevSelections = [];
		this.postMessage({
			type: 'clear',
			data: {
				description,
			},
		} as Msg);
	}

}

/**
 * Provides the outline tree.
 * 
 */

function recursiveInvisbleNotCommentSymbol(textDocument: TextDocument, symbols: DocumentSymbol[]) {
	// 遍历 symbol的detail有没有值,没有值就去除这个symbol
	for (let i = symbols.length - 1; i >= 0; i--) {
		if (symbols[i].detail === '') {
			symbols.splice(i, 1);
		} else if (symbols[i].children) {
			recursiveInvisbleNotCommentSymbol(textDocument, symbols[i].children);
		}
	}

}


function recursiveModificationSymbols(textDocument: TextDocument, symbols: DocumentSymbol[]) {
	for (const symbol of symbols) {
		if (textDocument.languageId === 'javascript' || textDocument.languageId === 'typescript') {
			// 	for(let)
			// console.log(this.textDocument.languageId );
			if (symbol.kind === SymbolKind.Variable) {
				const lineString = textDocument.lineAt(symbol.range.start.line).text;
				// 如何当前行包含有const字符,就把kind属性改成 Constant属性
				if (lineString.includes('const')) {
					symbol.kind = SymbolKind.Constant;
				}
			}
			// 如果是enum类型, 那么它的children类型都改成constant 
			if (symbol.kind === SymbolKind.Enum) {
				symbol.children.forEach(child => {
					child.kind = SymbolKind.Constant;
				});
			}
			// 如果是常量类型,判断其所在的那一行是否存在 type 关键字, 如果有 那么将它的类型改成Key
			if (symbol.kind === SymbolKind.Variable) {
				const lineString = textDocument.lineAt(symbol.range.start.line).text;
				if (lineString.includes('type ')) {
					symbol.kind = SymbolKind.Key;
				}
			}
		}



		if (textDocument.languageId === 'python'
			|| textDocument.languageId === 'javascript'
			|| textDocument.languageId === 'typescript'
		) {
			// 读取前一行的内容, 如果是单行注释, 就将symbol.detail 改成注释内容
			if (symbol.range.start.line != 0) {
				const lineString = textDocument.lineAt(symbol.range.start.line - 1).text;
				const commentValue: { [key: string]: string } = {
					'python': '#',
					'javascript': '//',
					'typescript': '//'
				};

				const languageId: keyof typeof commentValue = textDocument.languageId as keyof typeof commentValue;

				// 正则判断并提取注释内容,舍弃注释符号和前后空格
				const reg = new RegExp(`^\\s*${commentValue[languageId]}\\s*(.*)\\s*`);
				if (reg.test(lineString)
					&& !lineString.includes("# group")
					&& !lineString.includes("# endgroup")
					&& !lineString.includes("# tag")
				) {
					const comment = lineString.match(reg);
					if (comment) {
						symbol.detail = comment[1];
					}
				}
			}
		}

		if (textDocument.languageId === 'javascript' || textDocument.languageId === 'typescript') {

			// 替换callback函数的name为注释名,注释换成“callback ”+ 之前的名字,没有注释名, 就用"callback"代替, 类型改成Struct
			if (symbol.kind === SymbolKind.Function) {
				if (symbol.name.includes('(')) {
					if (symbol.detail) {
						const name = symbol.detail;
						symbol.detail = 'callback ' + symbol.name;
						symbol.name = name
					}else{
						symbol.name = 'callback'
					}

					symbol.kind = SymbolKind.Struct;

				}

			}
		}


		if (symbol.children) {
			recursiveModificationSymbols(textDocument, symbol.children);
		}
	}
}

export class OutlineTree {

	private textDocument: TextDocument;

	private regionProvider?: RegionProvider;

	private nodes: SymbolNode[] = [];

	public toggleHiddenNotCommentSymbol: boolean = false

	/** The maximum number of times to try to update the symbols before giving up. */
	private readonly MAX_ATTEMPTS = 10;

	/** Times has tried to update the symbols. */
	private attempts = 0;

	private sortBy: Sortby = Sortby.position;

	constructor(textDocument: TextDocument, regionProvider?: RegionProvider, sortBy: Sortby = Sortby.position) {
		this.textDocument = textDocument;
		this.regionProvider = regionProvider;
		this.sortBy = sortBy;
	}

	getNodes() {
		return this.nodes;
	}

	/**
	 * Gets the outline tree.
	 */
	async updateSymbols() {
		const docSymbols = (await commands.executeCommand<DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			this.textDocument.uri,
		)) || [];

		recursiveModificationSymbols(this.textDocument, docSymbols)

		// Get symbols from region provider if this provider is not registered to vscode
		const regionSymbols = deepClone(
			this.regionProvider
				?.provideDocumentSymbols(this.textDocument, new CancellationTokenSource().token)
		);



		if (regionSymbols) {
			if ('then' in regionSymbols) {
				docSymbols?.push(...(await regionSymbols as DocumentSymbol[] || []));
			}
			else {
				docSymbols?.push(...(regionSymbols as DocumentSymbol[]));
			}
		}

		if (this.toggleHiddenNotCommentSymbol) {
			recursiveInvisbleNotCommentSymbol(this.textDocument, docSymbols as DocumentSymbol[])
		}


		if (docSymbols) {
			config.debug() && console.log(`[Outline-map]: Got symbols from ${this.textDocument.uri.toString()}.`, docSymbols);
			this.nodes = SymbolNode.fromDocumentSymbols(docSymbols, this.sortBy);
			// Reset attempts
			this.attempts = 0;
		}



		// Sometimes the symbol provider is not loaded yet when the command is executed
		// So we try again a few times
		// See https://github.com/microsoft/vscode/issues/169566
		else if (this.attempts < this.MAX_ATTEMPTS) {
			this.attempts++;
			// Try again in 300ms
			setTimeout(() => this.updateSymbols(), 300 * this.attempts);
			config.debug() && console.log(`Outline-map: Failed to get symbols of ${this.textDocument.uri.toString()}. Attempt ${this.attempts} of ${this.MAX_ATTEMPTS}.`);
		}
		else if (config.debug()) {
			throw new Error(`Outline-map: Failed to get symbols of ${this.textDocument.uri.toString()}.`);
		}
	}

	/**
	 * Finds the nodes in the given range.
	 * 
	 * if the range contains the start of a node, the node will be included.
	 * if the range does not contain any node, the node that contains the range will be included.
	 * 
	 * Returns the nodes that are in the range, 
	 * the nodes that overlaps with the range,
	 * and the closest node that is not in the range.
	 */
	findNodesIn(range: Range): {
		inRange: SymbolNode[],
		involves: SymbolNode[],
		closest: SymbolNode | undefined,
	} {
		const nodesInRange: SymbolNode[] = [];
		const nodesInvolved: SymbolNode[] = [];
		let closest: SymbolNode | undefined = undefined;
		let distance = Number.MAX_SAFE_INTEGER;

		(function find(nodes: SymbolNode[]) {
			let found = false;
			nodes.forEach(node => {
				const anchor = node.range.start.line;
				const end = node.range.end.line;
				const rs = range.start.line;
				const re = range.end.line;
				let isInRange = false;
				if (re >= anchor && rs <= anchor) {
					// the anchor is in the range
					nodesInRange.push(node);
					found = true;
					isInRange = true;
				}
				if (anchor <= re && end >= rs && node.children) {
					// the range and the node overlap
					const foundInChildren = find(node.children);
					found = found || foundInChildren;
					nodesInvolved.push(node);
				}
				if (re <= end && rs >= anchor && !found) {
					// the end is in the range
					nodesInRange.push(node);
					found = true;
					isInRange = true;
				}
				if (!isInRange) {
					// the node is not in the range
					const d = Math.min(Math.abs(anchor - re), Math.abs(anchor - rs));
					if (d < distance) {
						distance = d;
						closest = node;
					}
				}
			});
			return found;
		})(this.nodes);

		return {
			inRange: nodesInRange,
			involves: nodesInvolved,
			closest,
		};
	}
}

class Patcher {

	private oldNode: SymbolNode[];

	private newNode: SymbolNode[];

	private ops: Op[] = [];

	constructor(oldNode: SymbolNode[], newNode: SymbolNode[]) {
		this.oldNode = oldNode;
		this.newNode = newNode;
		this.patch();
	}

	getOps() {
		return this.ops;
	}

	private patch() {
		this.updateChildren(this.oldNode, this.newNode, ['#outline-root']);
	}

	/**
	 * Checks if two nodes are the same (they have the same name and kind).
	 */
	private sameNode(a: SymbolNode, b: SymbolNode) {
		return a.name === b.name && a.kind === b.kind;
	}

	/**
	 * Update the properties of the **same node**
	 */
	private patchNode(oldNode: SymbolNode, newNode: SymbolNode, selector: string[]) {
		// update properties except `name`, `kind` & `children`	
		const exclude = ['name', 'kind', 'children'];
		const properties = Object.keys(oldNode).filter(key => !exclude.includes(key));
		const selectorStr = selector.concat(`[data-key="${newNode.kind}-${newNode.name}"]`).join(' >.outline-children> ');
		for (const property of properties) {
			const oldValue = Object.getOwnPropertyDescriptor(oldNode, property)?.value;
			const newValue = Object.getOwnPropertyDescriptor(newNode, property)?.value;
			if (property === 'expand') {
				// Keep the expand status of the old node
				newNode.expand = oldValue;
				continue;
			}
			if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
				this.ops.push({
					selector: selectorStr,
					type: 'update',
					property,
					value: typeof newValue === 'object' ? JSON.stringify(newValue) : newValue,
				} as UpdateOp);
			}
		}

		const oldHasChildren = oldNode.children && oldNode.children.length > 0;
		const newHasChildren = newNode.children && newNode.children.length > 0;
		// if both oldNode and newNode have children
		if (oldHasChildren && newHasChildren) {
			this.updateChildren(
				oldNode.children,
				newNode.children,
				selector.concat(`[data-key="${newNode.kind}-${newNode.name}"]`)
			);
		}
		// if oldNode has children but newNode doesn't
		else if (oldHasChildren && !newHasChildren) {
			this.ops.push({
				selector: selectorStr,
				type: 'delete',
				nodes: oldNode.children,
			} as DeleteOp);
		}
		// if newNode has children but oldNode doesn't
		else if (!oldHasChildren && newHasChildren) {
			this.ops.push({
				selector: selectorStr,
				type: 'insert',
				before: null,
				nodes: newNode.children,
			} as InsertOp);
		}
	}

	/**
	 * Update the children of the **same node**
	 * https://juejin.cn/post/7000266544181674014#heading-28
	 * https://github.com/snabbdom/snabbdom/blob/230aa23a694726921c405c4b353e8cb6968483bb/src/init.ts
	 */
	private updateChildren(oldChildren: SymbolNode[], newChildren: SymbolNode[], selector: string[]) {
		let oldStartIdx = 0;
		let newStartIdx = 0;
		let oldEndIdx = oldChildren.length - 1;
		let newEndIdx = newChildren.length - 1;
		let oldStartNode = oldChildren[oldStartIdx];
		let newStartNode = newChildren[newStartIdx];
		let oldEndNode = oldChildren[oldEndIdx];
		let newEndNode = newChildren[newEndIdx];
		const selectorStr = selector.join(' >.outline-children> ');

		while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
			if (this.sameNode(oldStartNode, newStartNode)) {
				// update properties
				this.patchNode(oldStartNode, newStartNode, selector);
				oldStartNode = oldChildren[++oldStartIdx];
				newStartNode = newChildren[++newStartIdx];
			}
			else if (this.sameNode(oldEndNode, newEndNode)) {
				// update properties
				this.patchNode(oldEndNode, newEndNode, selector);
				oldEndNode = oldChildren[--oldEndIdx];
				newEndNode = newChildren[--newEndIdx];
			}
			else if (this.sameNode(oldStartNode, newEndNode)) {
				// update properties and move to the end
				this.patchNode(oldStartNode, newEndNode, selector);
				this.ops.push({
					selector: selectorStr,
					type: 'move',
					nodes: [oldStartNode],
					before: oldChildren[oldEndIdx + 1] || null
				} as MoveOp);
				oldStartNode = oldChildren[++oldStartIdx];
				newEndNode = newChildren[--newEndIdx];
			}
			else if (this.sameNode(oldEndNode, newStartNode)) {
				// update properties and move to the start
				this.patchNode(oldEndNode, newStartNode, selector);
				this.ops.push({
					selector: selectorStr,
					type: 'move',
					nodes: [oldEndNode],
					before: oldChildren[oldStartIdx] || null
				} as MoveOp);
				oldEndNode = oldChildren[--oldEndIdx];
				newStartNode = newChildren[++newStartIdx];
			}
			else {
				// find the index of the newStartNode in the oldChildren
				const idx = oldChildren.findIndex(node => this.sameNode(node, newStartNode));
				if (idx >= 0) {
					this.patchNode(oldChildren[idx], newStartNode, selector);
					this.ops.push({
						selector: selectorStr,
						type: 'move',
						nodes: [oldChildren[idx]],
						before: oldChildren[oldStartIdx] || null
					} as MoveOp);
					oldChildren.splice(idx, 1);
				}
				else {
					this.ops.push({
						selector: selectorStr,
						type: 'insert',
						nodes: [newStartNode],
						before: oldChildren[oldStartIdx],
					} as InsertOp);
					newStartIdx++;
					break;
				}
			}

		}

		if (oldStartIdx <= oldEndIdx) {
			this.ops.push({
				selector: selectorStr,
				type: 'delete',
				nodes: oldChildren.slice(oldStartIdx, oldEndIdx + 1),
			} as DeleteOp);
		}

		if (newStartIdx <= newEndIdx) {
			this.ops.push({
				selector: selectorStr,
				type: 'insert',
				nodes: newChildren.slice(newStartIdx, newEndIdx + 1),
				before: oldChildren[oldStartIdx] || null,
			} as InsertOp);
		}
	}
}