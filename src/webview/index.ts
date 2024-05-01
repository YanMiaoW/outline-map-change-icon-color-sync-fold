/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { DeleteOp, InsertOp, MoveOp, ScrollMsg, Msg, ChangeDepthMsg , SymbolNode, UpdateOp, UpdateMsg, ConfigMsg, GotoMsg,ExpandMsg, FocusMsg, ClearMsg } from '../common';

const vscode = acquireVsCodeApi();

import 'overlayscrollbars/overlayscrollbars.css';
import { OverlayScrollbars } from 'overlayscrollbars';

import './main.scss';
import { Input } from './input';
import '@vscode/codicons/dist/codicon.css';
import { ColorTable, SymbolKindList, mapIcon } from '../utils';
import { SymbolKindStr } from '../utils';
/**
 * The root element of the outline
 */
const {root, input} = init();

let maxDepth = Infinity;

let debug = false;

/**
 * Handler of Message from backend
 */
const SMsgHandler = {
	update: (msg: UpdateMsg) => {
		msg.data.patches.forEach(patch => {
			const target = document.querySelector(patch.selector) as HTMLDivElement | null;
			const siblingContainer = document.querySelector(`${patch.selector}>.outline-children`) || root;
			if (!target) return;

			switch (patch.type) {
			case 'update':
				PatchHandler.update(patch as UpdateOp, target);
				break;
			case 'move':
				PatchHandler.move(patch as MoveOp, siblingContainer);
				break;
			case 'insert':
				PatchHandler.insert(patch as InsertOp, siblingContainer);
				target.classList.toggle('leaf', false);
				target.dataset.expand = 'true';
				break;
			case 'delete':
				PatchHandler.delete(patch as DeleteOp, siblingContainer);
				target.classList.toggle('leaf', siblingContainer?.children.length === 0);
				break;
			}
		});
	},
	scroll: (msg: ScrollMsg) => {
		const target = 0.33;
		// scroll the first node in viewport to the `target` of the screen
		const node = document.querySelector(`.${msg.data.follow}`) as HTMLDivElement | null;
		if (!node) return;
		const rect = node.getBoundingClientRect();
		const offset = rect.top + window.scrollY - window.innerHeight * target;		
		// smooth scroll
		window.scrollTo({
			top: offset,
			behavior: 'smooth'
		});
	},

	config: (msg: ConfigMsg) => {
		// TODO: Color configuration is deprecated
		// The following injection code should be removed
		// #region DEPRECATED
		const color = msg.data.color as { [key: string]: string };
		const colorStyle = document.querySelector('#color-style') as HTMLStyleElement;

		colorStyle.innerHTML = '';
		for (const key in color) {
			if (!Object.prototype.hasOwnProperty.call(color, key)) continue;
			
			if (key === 'focusingItem' || key === 'visibleRange') {
				colorStyle.innerHTML += `:root {--${key}-color: ${color[key]}}`;
				continue;
			}

			colorStyle.innerHTML += `[data-kind="${key}" i] {color: ${color[key]}}`;
		}
		//#endregion DEPRECATED
		maxDepth = msg.data.depth as number || Infinity;
		debug = msg.data.debug as boolean || false;
	},
	changeDepth: (msg: ChangeDepthMsg) => {
		maxDepth = Math.max(1, maxDepth + msg.data.delta);
		new Toast(`Depth: ${maxDepth}`, 3000);
	},
	switchSearchField: (toggle: boolean) => {
		const inputContainer = document.querySelector('#input-container') as HTMLDivElement;
		if (inputContainer.classList.contains('active') && toggle) {
			inputContainer.classList.toggle('active', false);
		}
		else {
			inputContainer.classList.toggle('active', true);
			input.start();
		}
	},
	clear: (description: string) => {
		const container = document.querySelector('.outline-children') as HTMLDivElement;
		container.innerHTML = '';
		const noOutline = document.querySelector('#no-outline') as HTMLDivElement;
		noOutline.innerText = description;
	}
};

/**
 * Apply patch to DOM
 */
const PatchHandler = {
	update: (patch: UpdateOp, target: HTMLDivElement) => {
		target.dataset[patch.property] = patch.value?.toString();
	},
	move: (patch: MoveOp, siblingContainer: Element) => {
		const sibling = Array.from(siblingContainer?.children || []);
		const nodes = patch.nodes.map(node => 
			matchKey(sibling, node) as HTMLDivElement
		);

		const before = matchKey(sibling, patch.before);
		
		nodes.forEach(node => {
			siblingContainer?.insertBefore(node, before);
		});
	},
	insert: (patch: InsertOp, siblingContainer: Element) => {
		const sibling = Array.from(siblingContainer?.children || []);
		const before = matchKey(sibling, patch.before);
		const depth = +((siblingContainer.parentElement as HTMLDivElement | null)?.style.getPropertyValue('--depth') || '0') + 1;

		patch.nodes.forEach(node => {			
			siblingContainer?.insertBefore(renderSymbolNode(node,depth), before);
		});
	},
	delete: (patch: DeleteOp, siblingContainer: Element) => {
		const sibling = Array.from(siblingContainer?.children || []);
		patch.nodes.forEach(node => {
			const element = matchKey(sibling, node);
			element?.remove();
		});
	}
};

/**
 * Match element by node
 */
function matchKey(elements: Element[], node: SymbolNode | null): Element | null {
	if (!node) return null;
	const key = `${node.kind}-${node.name}`;
	return elements.find(element => (element as HTMLDivElement).dataset.key === key) || null;
}

/**
 * Initialize the outline
 * @returns The root element of the outline
 */
function init() {
	const root = document.createElement('div');
	root.id = 'outline-root';
	root.innerHTML = /*html*/`
		<div class="outline-children"></div>
	`;

	const noOutline = document.createElement('div');
	noOutline.id = 'no-outline';
	noOutline.innerText = 'The active editor cannot provide outline information.';
	
	document.body.appendChild(root);
	document.body.appendChild(noOutline);

	const style = document.createElement('style');
	style.innerHTML = SymbolKindList.map(sym => 
		`[data-kind="${sym}" i] {color: var(--vscode-${ColorTable[sym].replace('.', '-')})}`
	).join('\n');

	document.body.appendChild(style);

	OverlayScrollbars(document.body, {
		overflow: {
			x: 'hidden',
			y: 'visible-scroll',
		},
		scrollbars: {
			autoHide: 'leave',
			autoHideDelay: 300,
		}
	});

	window.addEventListener('message', event => {
		const message = event.data as Msg;
		debug && console.log('[Outline-Map] Received message', message);
		switch (message.type) {
		case 'update':
			noOutline.innerHTML = '';
			SMsgHandler.update(message as UpdateMsg);
			break;
		case 'scroll':
			SMsgHandler.scroll(message as ScrollMsg);
			break;
		case 'config':
			SMsgHandler.config(message as ConfigMsg);
			break;
		case 'changeDepth':
			SMsgHandler.changeDepth(message as ChangeDepthMsg);
			break;
		case 'focus':
			SMsgHandler.switchSearchField((message as FocusMsg).toggle);
			break;
		case 'clear':
			SMsgHandler.clear((message as ClearMsg).data.description);
			break;
		}
	});

	const input = new Input();	

	return {root, input};
}

/**
 * Render symbolNode to DOM element
 */
function renderSymbolNode(symbolNode: SymbolNode, depth = 0): HTMLDivElement {
	const container = document.createElement('div');
	container.classList.add('outline-node');
	container.dataset.key = `${symbolNode.kind}-${symbolNode.name}`;
	container.dataset.kind = symbolNode.kind;
	container.dataset.name = symbolNode.name;
	container.dataset.detail = symbolNode.detail;
	container.dataset.expand = depth >= maxDepth ? 'false' : symbolNode.expand.toString();
	container.dataset.inview = symbolNode.inView.toString();
	container.dataset.focus = symbolNode.focus.toString();
	container.dataset.range = JSON.stringify(symbolNode.range);
	container.classList.toggle('leaf', symbolNode.children.length === 0);
	container.style.setProperty('--depth', depth.toString());
	// <span class="symbol-icon codicon codicon-${mapIcon(symbolNode.kind)}"></span>
// <path fill="currentColor" d="M54.8 119.49a35.06 35.06 0 0 1-5.75 8.51a35.06 35.06 0 0 1 5.75 8.51C60 147.24 60 159.83 60 172c0 25.94 1.84 32 20 32a12 12 0 0 1 0 24c-19.14 0-32.2-6.9-38.8-20.51C36 196.76 36 184.17 36 172c0-25.94-1.84-32-20-32a12 12 0 0 1 0-24c18.16 0 20-6.06 20-32c0-12.17 0-24.76 5.2-35.49C47.8 34.9 60.86 28 80 28a12 12 0 0 1 0 24c-18.16 0-20 6.06-20 32c0 12.17 0 24.76-5.2 35.49M240 116c-18.16 0-20-6.06-20-32c0-12.17 0-24.76-5.2-35.49C208.2 34.9 195.14 28 176 28a12 12 0 0 0 0 24c18.16 0 20 6.06 20 32c0 12.17 0 24.76 5.2 35.49A35.06 35.06 0 0 0 207 128a35.06 35.06 0 0 0-5.75 8.51C196 147.24 196 159.83 196 172c0 25.94-1.84 32-20 32a12 12 0 0 0 0 24c19.14 0 32.2-6.9 38.8-20.51c5.2-10.73 5.2-23.32 5.2-35.49c0-25.94 1.84-32 20-32a12 12 0 0 0 0-24" />

	container.innerHTML = /*html*/`
	<svg style="display: none;">
	<symbol id="icon-Function">
	<path stroke="null" id="svg_1" d="m16.19265,2.42221c-1.30007,-0.11819 -2.44649,0.83913 -2.56468,2.15102l-0.29547,3.41563l3.3329,0l0,2.36376l-3.54563,0l-0.52003,5.99212a4.71097,4.71097 0 0 1 -5.11753,4.29022a4.72751,4.72751 0 0 1 -3.61655,-2.21011l1.77282,-1.77282c0.28365,0.87459 1.06369,1.54826 2.04465,1.63099c1.30007,0.11819 2.44649,-0.83913 2.56468,-2.15102l0.50821,-5.77939l-3.54563,0l0,-2.36376l3.74655,0l0.31911,-3.62837c0.22456,-2.60013 2.5174,-4.52659 5.11753,-4.29022c1.54826,0.13001 2.84833,0.99278 3.61655,2.21011l-1.77282,1.77282c-0.28365,-0.87459 -1.06369,-1.54826 -2.04465,-1.63099" fill="currentColor" />
	</symbol>
  </svg>
  <svg style="display: none;">
  <symbol id="icon-Variable">
	<path stroke="null" fill="currentColor" d="m12.28103,9.73671l3.01622,-4.14679l3.28924,0l-5.58973,5.66888l3.53558,7.06676l-2.93821,0l-1.79413,-4.32652l-3.15923,4.27517l-3.27624,0l5.07036,-6.57323l-2.7692,-6.11105l2.95121,0l1.66412,4.14679z" id="svg_1"/>
  </symbol>
</svg>
<svg style="display: none;">
<symbol id="icon-Class">
<path stroke="null" id="svg_1" d="m12.51939,6.62526l-1.94279,0.06163c-0.13658,-1.62555 -1.13549,-2.26667 -2.37515,-2.26667c-1.23966,0 -2.8705,0.77066 -2.8705,3.38411c0,2.61346 1.6539,3.63063 2.91339,3.63063c0.94763,0 2.26406,-0.67872 2.39389,-2.0002l1.88116,-0.04155c-0.12983,1.77079 -1.54191,3.88823 -4.33126,3.88823c-2.62071,0 -4.59093,-1.88723 -4.59093,-5.35385c0,-3.48 2.02643,-5.35385 4.59093,-5.35385c2.39852,0 4.12782,1.46562 4.33126,4.05152" fill-rule="evenodd" fill="currentColor"/>
</symbol>
</svg>
<svg style="display: none;">
<symbol id="icon-__om_Region__">
<path id="svg_1" d="m69.74684,118.00159a35.06,35.06 0 0 1 -5.75,8.51a35.06,35.06 0 0 1 5.75,8.51c5.2,10.73 5.2,23.32 5.2,35.49c0,25.94 1.84,32 20,32a12,12 0 0 1 0,24c-19.14,0 -32.2,-6.9 -38.8,-20.51c-5.2,-10.73 -5.2,-23.32 -5.2,-35.49c0,-25.94 -1.84,-32 -20,-32a12,12 0 0 1 0,-24c18.16,0 20,-6.06 20,-32c0,-12.17 0,-24.76 5.2,-35.49c6.6,-13.61 19.66,-20.51 38.8,-20.51a12,12 0 0 1 0,24c-18.16,0 -20,6.06 -20,32c0,12.17 0,24.76 -5.2,35.49m155.2,-3.49c-18.16,0 -20,-6.06 -20,-32c0,-12.17 0,-24.76 -5.2,-35.49c-6.6,-13.61 -19.66,-20.51 -38.8,-20.51a12,12 0 0 0 0,24c18.16,0 20,6.06 20,32c0,12.17 0,24.76 5.2,35.49a35.06,35.06 0 0 0 5.8,8.51a35.06,35.06 0 0 0 -5.75,8.51c-5.25,10.73 -5.25,23.32 -5.25,35.49c0,25.94 -1.84,32 -20,32a12,12 0 0 0 0,24c19.14,0 32.2,-6.9 38.8,-20.51c5.2,-10.73 5.2,-23.32 5.2,-35.49c0,-25.94 1.84,-32 20,-32a12,12 0 0 0 0,-24" fill="currentColor" stroke="null"/>
</symbol>
<symbol id="icon-Enum">
<path stroke="null" id="svg_1" d="m4.1917,13.07755l0,-10.79847l7.45061,0l0,1.52954l-5.50836,0.03931l-0.03931,2.92262l5.28091,0l0,1.77081l-5.28091,0l0,2.73147l5.62629,0l0,1.80472l-7.52924,0z" fill-rule="evenodd" fill="currentColor"/>
</symbol>
<symbol id="icon-Interface">
<path transform="rotate(0.0485013 7.84397 7.96502)" stroke="null" id="svg_1" d="m8.73691,11.72416l2.75165,-0.00034l0.02825,1.69455l-7.34566,0l0.00017,-1.63783l2.78002,-0.00036l0.02806,-7.60269l-2.77999,0.02873l-0.02825,-1.69455l7.34566,0l-0.00019,1.60947l-2.78002,0.00036l0.00031,7.60266z" fill-rule="evenodd" fill="currentColor"/>
</symbol>
<symbol id="icon-Key">
<path stroke="currentColor" id="svg_1" d="m4.42619,7.77254l0,-2.54197l12.06105,-0.0976l0.04867,2.59077m-8.61443,11.01521l5.07046,0m-2.53523,-13.55718l0,13.55718" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" fill="none"/>
</symbol>s
</svg>
	  <div class="outline-label">
		<span class="expand-btn codicon codicon-chevron-right"></span>
		${
				// 根据不同的类型返回不同的 SVG，保留默认的codicon处理作为默认情况
				// symbolNode.kind === 'Function' ? '<div class="cossc"><svg xmlns="http://www.w3.org/2000/svg" width="1.4em" height="1.4em" style="transform: translateY(-1px);" viewBox="0 0 24 24"><path fill="currentColor" d="M15.6 5.29c-1.1-.1-2.07.71-2.17 1.82L13.18 10H16v2h-3l-.44 5.07a3.986 3.986 0 0 1-4.33 3.63a4 4 0 0 1-3.06-1.87l1.5-1.5c.24.74.9 1.31 1.73 1.38c1.1.1 2.07-.71 2.17-1.82L11 12H8v-2h3.17l.27-3.07c.19-2.2 2.13-3.83 4.33-3.63c1.31.11 2.41.84 3.06 1.87l-1.5 1.5c-.24-.74-.9-1.31-1.73-1.38"/></svg></div> ' :
				// symbolNode.kind === 'Function' ? '<div class="cossc"><svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"> <g> <title>Layer 1</title> <path stroke="null" id="svg_1" d="m16.19265,2.42221c-1.30007,-0.11819 -2.44649,0.83913 -2.56468,2.15102l-0.29547,3.41563l3.3329,0l0,2.36376l-3.54563,0l-0.52003,5.99212a4.71097,4.71097 0 0 1 -5.11753,4.29022a4.72751,4.72751 0 0 1 -3.61655,-2.21011l1.77282,-1.77282c0.28365,0.87459 1.06369,1.54826 2.04465,1.63099c1.30007,0.11819 2.44649,-0.83913 2.56468,-2.15102l0.50821,-5.77939l-3.54563,0l0,-2.36376l3.74655,0l0.31911,-3.62837c0.22456,-2.60013 2.5174,-4.52659 5.11753,-4.29022c1.54826,0.13001 2.84833,0.99278 3.61655,2.21011l-1.77282,1.77282c-0.28365,-0.87459 -1.06369,-1.54826 -2.04465,-1.63099" fill="currentColor"/> </g> </svg></div> ' :
				symbolNode.kind === 'Function' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="18" height="18" viewBox="0 0 24 24"> <use xlink:href="#icon-Function"></use> </svg></div> ' :
				symbolNode.kind === 'Method' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="18" height="18" viewBox="0 0 24 24"> <use xlink:href="#icon-Function"></use> </svg></div> ' :
				// symbolNode.kind === 'Class' ? '<div class="cossc"><svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"> <g> <title>Layer 1</title> <path stroke="null" id="svg_1" d="m12.34598,6.90935l-1.94279,0.06163c-0.13658,-1.62555 -1.13549,-2.26667 -2.37515,-2.26667c-1.23966,0 -2.8705,0.77066 -2.8705,3.38411c0,2.61346 1.6539,3.63063 2.91339,3.63063c0.94763,0 2.26406,-0.67872 2.39389,-2.0002l1.88116,-0.04155c-0.12983,1.77079 -1.54191,3.88823 -4.33126,3.88823c-2.62071,0 -4.59093,-1.88723 -4.59093,-5.35385c0,-3.48 2.02643,-5.35385 4.59093,-5.35385c2.39852,0 4.12782,1.46562 4.33126,4.05152" fill-rule="evenodd" fill="currentColor"/> </g> </svg></div> ' :
				symbolNode.kind === 'Class' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"> <use xlink:href="#icon-Class"></use> </svg></div> ' :
				// symbolNode.kind === 'Class' ? '<div class="cossc"><svg xmlns="http://www.w3.org/2000/svg" width="3em" height="3em" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M11.333 7.027H9.375c-.056-.708-.48-1.187-1.222-1.187c-.972 0-1.5.806-1.5 2.16c0 1.43.545 2.16 1.486 2.16c.708 0 1.139-.415 1.236-1.08l1.958.015C11.236 10.418 10.181 12 8.097 12c-1.958 0-3.43-1.41-3.43-4c0-2.6 1.514-4 3.43-4c1.792 0 3.084 1.095 3.236 3.027"/></svg></div> ' :
				symbolNode.kind === 'Variable' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="18" height="18" viewBox="0 0 24 24"> <use xlink:href="#icon-Variable"></use> </svg></div> ' :
				symbolNode.kind === 'Key' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="18" height="18" viewBox="0 0 24 24"> <use xlink:href="#icon-Key"></use> </svg></div> ' :
				symbolNode.kind === 'Enum' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="16" height="16" viewBox="0 0 16 16"> <use xlink:href="#icon-Enum"></use> </svg></div> ' :
				symbolNode.kind === 'Interface' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="16" height="16" viewBox="0 0 16 16"> <use xlink:href="#icon-Interface"></use> </svg></div> ' :
				symbolNode.kind === 'Constant' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="18" height="18" viewBox="0 0 24 24"> <use xlink:href="#icon-Variable"></use> </svg></div> ' :
				symbolNode.kind === 'Property' ? '  <div class="cossc"><svg style="transform: translateY(2px);" width="18" height="18" viewBox="0 0 24 24"> <use xlink:href="#icon-Variable"></use> </svg></div> ' :
				// symbolNode.kind === '__om_Region__' ? '<div class="cossc"><svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"> <g> <title>Layer 1</title> <path id="svg_1" clip-rule="evenodd" d="m4.25,2.5a0.841,0.841 0 0 0 -0.837,0.921l0.2,2.096a2.399,2.399 0 0 1 -1.573,2.483a2.399,2.399 0 0 1 1.571,2.483l-0.2,2.096a0.841,0.841 0 0 0 0.838,0.921a0.75,0.75 0 0 1 0,1.5a2.341,2.341 0 0 1 -2.33,-2.563l0.199,-2.096a0.898,0.898 0 0 0 -0.677,-0.957l-0.139,-0.035a1.39,1.39 0 0 1 0,-2.698l0.14,-0.035a0.898,0.898 0 0 0 0.676,-0.957l-0.2,-2.096a2.341,2.341 0 0 1 2.332,-2.563a0.75,0.75 0 0 1 0,1.5m8.338,10.079a0.841,0.841 0 0 1 -0.838,0.921a0.75,0.75 0 0 0 0,1.5a2.341,2.341 0 0 0 2.33,-2.563l-0.199,-2.096a0.898,0.898 0 0 1 0.677,-0.957l0.139,-0.035a1.39,1.39 0 0 0 0,-2.698l-0.14,-0.035a0.898,0.898 0 0 1 -0.676,-0.957l0.2,-2.096a2.341,2.341 0 0 0 -2.331,-2.563a0.75,0.75 0 0 0 0,1.5c0.496,0 0.884,0.427 0.838,0.921l-0.2,2.096a2.399,2.399 0 0 0 1.571,2.483a2.399,2.399 0 0 0 -1.571,2.483l0.2,2.096z" fill-rule="evenodd" fill="currentColor"/> </g> </svg></div> ' :
				// symbolNode.kind === '__om_Region__' ? '<div class="cossc"><svg xmlns="http://www.w3.org/2000/svg" width="1.6em" height="1.6em" viewBox="0 0 256 256"><path fill="currentColor" d="M54.8 119.49a35.06 35.06 0 0 1-5.75 8.51a35.06 35.06 0 0 1 5.75 8.51C60 147.24 60 159.83 60 172c0 25.94 1.84 32 20 32a12 12 0 0 1 0 24c-19.14 0-32.2-6.9-38.8-20.51C36 196.76 36 184.17 36 172c0-25.94-1.84-32-20-32a12 12 0 0 1 0-24c18.16 0 20-6.06 20-32c0-12.17 0-24.76 5.2-35.49C47.8 34.9 60.86 28 80 28a12 12 0 0 1 0 24c-18.16 0-20 6.06-20 32c0 12.17 0 24.76-5.2 35.49M240 116c-18.16 0-20-6.06-20-32c0-12.17 0-24.76-5.2-35.49C208.2 34.9 195.14 28 176 28a12 12 0 0 0 0 24c18.16 0 20 6.06 20 32c0 12.17 0 24.76 5.2 35.49A35.06 35.06 0 0 0 207 128a35.06 35.06 0 0 0-5.75 8.51C196 147.24 196 159.83 196 172c0 25.94-1.84 32-20 32a12 12 0 0 0 0 24c19.14 0 32.2-6.9 38.8-20.51c5.2-10.73 5.2-23.32 5.2-35.49c0-25.94 1.84-32 20-32a12 12 0 0 0 0-24"/></svg></div> ' :
				symbolNode.kind === '__om_Region__' ? '  <div class="cossc"><svg style="transform: translateY(1px);" width="1.6em" height="1.6em" viewBox="0 0 256 256"> <use xlink:href="#icon-__om_Region__"></use> </svg></div> ' :
				// symbolNode.kind === '__om_Region__' ? '<div class="cossc"><svg xmlns="http://www.w3.org/2000/svg" width="1.4em" height="1.4em" viewBox="0 0 48 48"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M16 4c-2 0-5 1-5 5v9c0 3-5 5-5 5s5 2 5 5v11c0 4 3 5 5 5M32 4c2 0 5 1 5 5v9c0 3 5 5 5 5s-5 2-5 5v11c0 4-3 5-5 5"/></svg></div> ' :
				// 返回默认的 codicon
				`<span class="symbol-icon codicon codicon-${mapIcon(symbolNode.kind)}"></span>`

		}

		<span class="symbol-text" title="[${symbolNode.kind.toLowerCase()}] ${symbolNode.name} ${symbolNode.detail}">
			<span class="symbol-name">${symbolNode.name}</span>
			<span class="symbol-detail">&nbsp;&nbsp;${symbolNode.detail}</span>
		</span>
		<span class="diagnostic"></span>
		<span class="quick-nav"></span>
	  </div>
	  <div class="outline-children"></div>
	`;

	const childrenContainer = container.querySelector('.outline-children') as HTMLDivElement;

	symbolNode.children.forEach(child => {
		const element = renderSymbolNode(child, depth+1);
		childrenContainer.appendChild(element);
	});

	const expandBtn = container.querySelector('.expand-btn') as HTMLSpanElement;
	expandBtn.addEventListener('click', event => {
		event.stopPropagation();	
		const nextExpand = container.dataset.expand === 'true' ? 'false' : 'true'
		container.dataset.expand = nextExpand;
		vscode.postMessage({
			type: 'expand',
			data: {
				position: symbolNode.selectionRange.start,
				expand: nextExpand === 'true',
			}
		} as ExpandMsg);
	});

	const label = container.querySelector('.outline-label') as HTMLSpanElement;
	label.addEventListener('click', () => {
		input.stopSearch();
		vscode.postMessage({
			type: 'goto',
			data: {
				position: symbolNode.selectionRange.start,
			}
		} as GotoMsg);
	});


	mutObserver.observe(container, mutObserverConfig);

	return container;
}

function mutationCallback(mutationsList: MutationRecord[], observer: MutationObserver) {
	// observe data-set change
	mutationsList.filter(mutation => mutation.type === 'attributes').forEach(mutation => {
		const element = mutation.target as HTMLDivElement;
		
		switch (mutation.attributeName) {
		case 'data-detail':
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			element.querySelector('.symbol-detail')!.textContent = element.dataset.detail || '';
			break;
		case 'data-expand': {
			const depth = +(element?.style.getPropertyValue('--depth') || '0') + 1;
			
			if (depth > maxDepth) {
				element.classList.toggle('expand', false);
				break;
			}
			element.classList.toggle('expand', element.dataset.expand === 'true');
			break;
		}
		case 'data-inview':
			element.classList.toggle('in-view', element.dataset.inview === 'true');
			break;
		case 'data-focus':
			element.classList.toggle('focus', element.dataset.focus === 'true');
			break;
		case 'data-diagnostictype':
			element.classList.toggle('diagnostic-error', element.dataset['diagnostictype'] === 'error');
			element.classList.toggle('diagnostic-warning', element.dataset['diagnostictype'] === 'warning');
			break;
		case 'data-diagnosticcount': {
			const count = parseInt(element.dataset['diagnosticcount'] || '0');
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			element.querySelector('.diagnostic')!.textContent = 
				count > 9 ? '9+' : 
					count === -1 ? '' :
						count.toString();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			element.querySelector('.diagnostic')!
				.setAttribute('title', 
					count === -1 ? 
						'Contains elements with problems' : 
						`${count} problems in this element`
				);
			element.classList.toggle('has-diagnostic', count !== 0);
			element.classList.toggle('diagnostic-in-children', count === -1);
			break;
		}}
	});
}

const mutObserverConfig = {
	attributes: true,
	attributeFilter: ['data-detail', 'data-expand', 'data-inview', 'data-focus', 'data-diagnostictype', 'data-diagnosticcount'],
	childList: false,
	subtree: false,
};

const mutObserver = new MutationObserver(mutationCallback);

class Toast{
	message: string;
	duration: number;
	element: HTMLDivElement;

	constructor(message: string, duration = 3000){
		this.message = message;
		this.duration = duration;
		this.element = document.createElement('div');
		this.element.classList.add('toast');
		this.element.innerText = message;
		document.body.appendChild(this.element);
		setTimeout(() => {
			this.remove();
		}, duration);
	}

	remove(){
		this.element.style.opacity = '0';
		setTimeout(() => {
			this.element.remove();
		}, 300);
	}
}
