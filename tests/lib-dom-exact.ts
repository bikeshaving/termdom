// Type-level check that this DOM's classes match lib.dom member for member.
// Compiled by tsc, never run. scripts/lib-dom-drift.mjs prints what each
// Drift alias resolves to, and exits nonzero when any is not `never`.
import type * as DOM from "../src/internal/dom.ts";

type Identical<A, B> =
	(<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
		? true
		: false;

// Every one of this DOM's classes mapped to the platform interface it
// implements. A member type is mapped before it is compared, so the
// comparison never recurses into a class of ours. Matching is by identity:
// a subclass that adds no member of its own would otherwise be structurally
// indistinguishable from its base, and a platform type would match the
// smallest class of ours it happens to satisfy.
type Map0<T> =
	Identical<T, DOM.Event> extends true
		? globalThis.Event
		: Identical<T, DOM.CustomEvent> extends true
			? globalThis.CustomEvent
			: Identical<T, DOM.BeforeUnloadEvent> extends true
				? globalThis.BeforeUnloadEvent
				: Identical<T, DOM.MessageEvent> extends true
					? globalThis.MessageEvent
					: Identical<T, DOM.HashChangeEvent> extends true
						? globalThis.HashChangeEvent
						: Identical<T, DOM.StorageEvent> extends true
							? globalThis.StorageEvent
							: Identical<T, DOM.UIEvent> extends true
								? globalThis.UIEvent
								: Identical<T, DOM.MouseEvent> extends true
									? globalThis.MouseEvent
									: Identical<T, DOM.FocusEvent> extends true
										? globalThis.FocusEvent
										: Identical<T, DOM.KeyboardEvent> extends true
											? globalThis.KeyboardEvent
											: Identical<T, DOM.CompositionEvent> extends true
												? globalThis.CompositionEvent
												: Identical<T, DOM.TextEvent> extends true
													? globalThis.TextEvent
													: Identical<T, DOM.InputEvent> extends true
														? globalThis.InputEvent
														: Identical<T, DOM.FileList> extends true
															? globalThis.FileList
															: Identical<T, DOM.DataTransferItem> extends true
																? globalThis.DataTransferItem
																: Identical<
																	T,
																	DOM.DataTransferItemList
																> extends true
																	? globalThis.DataTransferItemList
																	: Identical<T, DOM.DataTransfer> extends true
																		? globalThis.DataTransfer
																		: Identical<
																			T,
																			DOM.ClipboardEvent
																		> extends true
																			? globalThis.ClipboardEvent
																			: Identical<
																				T,
																				DOM.TransitionEvent
																			> extends true
																				? globalThis.TransitionEvent
																				: Identical<
																					T,
																					DOM.AnimationEvent
																				> extends true
																					? globalThis.AnimationEvent
																					: Identical<
																						T,
																						DOM.WheelEvent
																					> extends true
																						? globalThis.WheelEvent
																						: Identical<
																							T,
																							DOM.PointerEvent
																						> extends true
																							? globalThis.PointerEvent
																							: Identical<
																								T,
																								DOM.DragEvent
																							> extends true
																								? globalThis.DragEvent
																								: Identical<
																									T,
																									DOM.EventTarget
																								> extends true
																									? globalThis.EventTarget
																									: Identical<
																										T,
																										DOM.Node
																									> extends true
																										? globalThis.Node
																										: Identical<
																											T,
																											DOM.MutationRecord
																										> extends true
																											? globalThis.MutationRecord
																											: Identical<
																												T,
																												DOM.MutationObserver
																											> extends true
																												? globalThis.MutationObserver
																												: Identical<
																													T,
																													DOM.NodeList
																												> extends true
																													? globalThis.NodeList
																													: Identical<
																														T,
																														DOM.HTMLCollection
																													> extends true
																														? globalThis.HTMLCollection
																														: Identical<
																															T,
																															DOM.DOMTokenList
																														> extends true
																															? globalThis.DOMTokenList
																															: Map1<T>;
type Map1<T> =
	Identical<T, DOM.CharacterData> extends true
		? globalThis.CharacterData
		: Identical<T, DOM.Text> extends true
			? globalThis.Text
			: Identical<T, DOM.CDATASection> extends true
				? globalThis.CDATASection
				: Identical<T, DOM.Comment> extends true
					? globalThis.Comment
					: Identical<T, DOM.ProcessingInstruction> extends true
						? globalThis.ProcessingInstruction
						: Identical<T, DOM.DocumentType> extends true
							? globalThis.DocumentType
							: Identical<T, DOM.DocumentFragment> extends true
								? globalThis.DocumentFragment
								: Identical<T, DOM.Attr> extends true
									? globalThis.Attr
									: Identical<T, DOM.NamedNodeMap> extends true
										? globalThis.NamedNodeMap
										: Identical<T, DOM.Element> extends true
											? globalThis.Element
											: Identical<T, DOM.HTMLElement> extends true
												? globalThis.HTMLElement
												: Identical<T, DOM.HTMLUnknownElement> extends true
													? globalThis.HTMLUnknownElement
													: Identical<T, DOM.SVGElement> extends true
														? globalThis.SVGElement
														: Identical<T, DOM.MathMLElement> extends true
															? globalThis.MathMLElement
															: Identical<
																T,
																DOM.CustomElementRegistry
															> extends true
																? globalThis.CustomElementRegistry
																: Identical<T, DOM.ShadowRoot> extends true
																	? globalThis.ShadowRoot
																	: Identical<
																		T,
																		DOM.HTMLSlotElement
																	> extends true
																		? globalThis.HTMLSlotElement
																		: Identical<
																			T,
																			DOM.HTMLTemplateElement
																		> extends true
																			? globalThis.HTMLTemplateElement
																			: Identical<
																				T,
																				DOM.HTMLAnchorElement
																			> extends true
																				? globalThis.HTMLAnchorElement
																				: Identical<
																					T,
																					DOM.HTMLAreaElement
																				> extends true
																					? globalThis.HTMLAreaElement
																					: Identical<
																						T,
																						DOM.HTMLBaseElement
																					> extends true
																						? globalThis.HTMLBaseElement
																						: Identical<
																							T,
																							DOM.HTMLBodyElement
																						> extends true
																							? globalThis.HTMLBodyElement
																							: Identical<
																								T,
																								DOM.HTMLBRElement
																							> extends true
																								? globalThis.HTMLBRElement
																								: Identical<
																									T,
																									DOM.HTMLButtonElement
																								> extends true
																									? globalThis.HTMLButtonElement
																									: Identical<
																										T,
																										DOM.HTMLCanvasElement
																									> extends true
																										? globalThis.HTMLCanvasElement
																										: Identical<
																											T,
																											DOM.HTMLDataElement
																										> extends true
																											? globalThis.HTMLDataElement
																											: Identical<
																												T,
																												DOM.HTMLDataListElement
																											> extends true
																												? globalThis.HTMLDataListElement
																												: Identical<
																													T,
																													DOM.HTMLDetailsElement
																												> extends true
																													? globalThis.HTMLDetailsElement
																													: Identical<
																														T,
																														DOM.ToggleEvent
																													> extends true
																														? globalThis.ToggleEvent
																														: Identical<
																															T,
																															DOM.HTMLDialogElement
																														> extends true
																															? globalThis.HTMLDialogElement
																															: Map2<T>;
type Map2<T> =
	Identical<T, DOM.HTMLDirectoryElement> extends true
		? globalThis.HTMLDirectoryElement
		: Identical<T, DOM.HTMLDivElement> extends true
			? globalThis.HTMLDivElement
			: Identical<T, DOM.HTMLDListElement> extends true
				? globalThis.HTMLDListElement
				: Identical<T, DOM.HTMLEmbedElement> extends true
					? globalThis.HTMLEmbedElement
					: Identical<T, DOM.HTMLFieldSetElement> extends true
						? globalThis.HTMLFieldSetElement
						: Identical<T, DOM.HTMLFontElement> extends true
							? globalThis.HTMLFontElement
							: Identical<T, DOM.HTMLFormElement> extends true
								? globalThis.HTMLFormElement
								: Identical<T, DOM.SubmitEvent> extends true
									? globalThis.SubmitEvent
									: Identical<T, DOM.HTMLFormControlsCollection> extends true
										? globalThis.HTMLFormControlsCollection
										: Identical<T, DOM.RadioNodeList> extends true
											? globalThis.RadioNodeList
											: Identical<T, DOM.HTMLFrameElement> extends true
												? globalThis.HTMLFrameElement
												: Identical<T, DOM.HTMLFrameSetElement> extends true
													? globalThis.HTMLFrameSetElement
													: Identical<T, DOM.HTMLHeadElement> extends true
														? globalThis.HTMLHeadElement
														: Identical<T, DOM.HTMLHeadingElement> extends true
															? globalThis.HTMLHeadingElement
															: Identical<T, DOM.HTMLHRElement> extends true
																? globalThis.HTMLHRElement
																: Identical<T, DOM.HTMLHtmlElement> extends true
																	? globalThis.HTMLHtmlElement
																	: Identical<
																		T,
																		DOM.HTMLIFrameElement
																	> extends true
																		? globalThis.HTMLIFrameElement
																		: Identical<
																			T,
																			DOM.HTMLImageElement
																		> extends true
																			? globalThis.HTMLImageElement
																			: Identical<
																				T,
																				DOM.HTMLInputElement
																			> extends true
																				? globalThis.HTMLInputElement
																				: Identical<
																					T,
																					DOM.HTMLLabelElement
																				> extends true
																					? globalThis.HTMLLabelElement
																					: Identical<
																						T,
																						DOM.HTMLLegendElement
																					> extends true
																						? globalThis.HTMLLegendElement
																						: Identical<
																							T,
																							DOM.HTMLLIElement
																						> extends true
																							? globalThis.HTMLLIElement
																							: Identical<
																								T,
																								DOM.HTMLLinkElement
																							> extends true
																								? globalThis.HTMLLinkElement
																								: Identical<
																									T,
																									DOM.HTMLMapElement
																								> extends true
																									? globalThis.HTMLMapElement
																									: Identical<
																										T,
																										DOM.HTMLMarqueeElement
																									> extends true
																										? globalThis.HTMLMarqueeElement
																										: Identical<
																											T,
																											DOM.HTMLMediaElement
																										> extends true
																											? globalThis.HTMLMediaElement
																											: Identical<
																												T,
																												DOM.HTMLAudioElement
																											> extends true
																												? globalThis.HTMLAudioElement
																												: Identical<
																													T,
																													DOM.HTMLVideoElement
																												> extends true
																													? globalThis.HTMLVideoElement
																													: Identical<
																														T,
																														DOM.HTMLMenuElement
																													> extends true
																														? globalThis.HTMLMenuElement
																														: Identical<
																															T,
																															DOM.HTMLMetaElement
																														> extends true
																															? globalThis.HTMLMetaElement
																															: Map3<T>;
type Map3<T> =
	Identical<T, DOM.HTMLMeterElement> extends true
		? globalThis.HTMLMeterElement
		: Identical<T, DOM.HTMLModElement> extends true
			? globalThis.HTMLModElement
			: Identical<T, DOM.HTMLObjectElement> extends true
				? globalThis.HTMLObjectElement
				: Identical<T, DOM.HTMLOListElement> extends true
					? globalThis.HTMLOListElement
					: Identical<T, DOM.HTMLOptGroupElement> extends true
						? globalThis.HTMLOptGroupElement
						: Identical<T, DOM.HTMLOptionElement> extends true
							? globalThis.HTMLOptionElement
							: Identical<T, DOM.HTMLOptionsCollection> extends true
								? globalThis.HTMLOptionsCollection
								: Identical<T, DOM.HTMLOutputElement> extends true
									? globalThis.HTMLOutputElement
									: Identical<T, DOM.HTMLParagraphElement> extends true
										? globalThis.HTMLParagraphElement
										: Identical<T, DOM.HTMLParamElement> extends true
											? globalThis.HTMLParamElement
											: Identical<T, DOM.HTMLPictureElement> extends true
												? globalThis.HTMLPictureElement
												: Identical<T, DOM.HTMLPreElement> extends true
													? globalThis.HTMLPreElement
													: Identical<T, DOM.HTMLProgressElement> extends true
														? globalThis.HTMLProgressElement
														: Identical<T, DOM.HTMLQuoteElement> extends true
															? globalThis.HTMLQuoteElement
															: Identical<T, DOM.HTMLScriptElement> extends true
																? globalThis.HTMLScriptElement
																: Identical<
																	T,
																	DOM.HTMLSelectElement
																> extends true
																	? globalThis.HTMLSelectElement
																	: Identical<
																		T,
																		DOM.HTMLSourceElement
																	> extends true
																		? globalThis.HTMLSourceElement
																		: Identical<
																			T,
																			DOM.HTMLSpanElement
																		> extends true
																			? globalThis.HTMLSpanElement
																			: Identical<
																				T,
																				DOM.HTMLStyleElement
																			> extends true
																				? globalThis.HTMLStyleElement
																				: Identical<
																					T,
																					DOM.HTMLTableCaptionElement
																				> extends true
																					? globalThis.HTMLTableCaptionElement
																					: Identical<
																						T,
																						DOM.HTMLTableCellElement
																					> extends true
																						? globalThis.HTMLTableCellElement
																						: Identical<
																							T,
																							DOM.HTMLTableColElement
																						> extends true
																							? globalThis.HTMLTableColElement
																							: Identical<
																								T,
																								DOM.HTMLTableElement
																							> extends true
																								? globalThis.HTMLTableElement
																								: Identical<
																									T,
																									DOM.HTMLTableRowElement
																								> extends true
																									? globalThis.HTMLTableRowElement
																									: Identical<
																										T,
																										DOM.HTMLTableSectionElement
																									> extends true
																										? globalThis.HTMLTableSectionElement
																										: Identical<
																											T,
																											DOM.HTMLTextAreaElement
																										> extends true
																											? globalThis.HTMLTextAreaElement
																											: Identical<
																												T,
																												DOM.HTMLTimeElement
																											> extends true
																												? globalThis.HTMLTimeElement
																												: Identical<
																													T,
																													DOM.HTMLTitleElement
																												> extends true
																													? globalThis.HTMLTitleElement
																													: Identical<
																														T,
																														DOM.HTMLTrackElement
																													> extends true
																														? globalThis.HTMLTrackElement
																														: Identical<
																															T,
																															DOM.HTMLUListElement
																														> extends true
																															? globalThis.HTMLUListElement
																															: Map4<T>;
type Map4<T> =
	Identical<T, DOM.DOMStringMap> extends true
		? globalThis.DOMStringMap
		: Identical<T, DOM.ValidityState> extends true
			? globalThis.ValidityState
			: Identical<T, DOM.CustomStateSet> extends true
				? globalThis.CustomStateSet
				: Identical<T, DOM.ElementInternals> extends true
					? globalThis.ElementInternals
					: Identical<T, DOM.DOMRectReadOnly> extends true
						? globalThis.DOMRectReadOnly
						: Identical<T, DOM.DOMRect> extends true
							? globalThis.DOMRect
							: Identical<T, DOM.DOMRectList> extends true
								? globalThis.DOMRectList
								: Identical<T, DOM.ResizeObserver> extends true
									? globalThis.ResizeObserver
									: Identical<T, DOM.IntersectionObserver> extends true
										? globalThis.IntersectionObserver
										: Identical<T, DOM.Document> extends true
											? globalThis.Document
											: Identical<T, DOM.XMLDocument> extends true
												? globalThis.XMLDocument
												: Identical<T, DOM.DOMImplementation> extends true
													? globalThis.DOMImplementation
													: Identical<T, DOM.AbstractRange> extends true
														? globalThis.AbstractRange
														: Identical<T, DOM.StaticRange> extends true
															? globalThis.StaticRange
															: Identical<T, DOM.Range> extends true
																? globalThis.Range
																: Identical<T, DOM.Selection> extends true
																	? globalThis.Selection
																	: Identical<T, DOM.NodeIterator> extends true
																		? globalThis.NodeIterator
																		: Identical<T, DOM.TreeWalker> extends true
																			? globalThis.TreeWalker
																			: Identical<T, DOM.DOMParser> extends true
																				? globalThis.DOMParser
																				: Identical<
																					T,
																					DOM.ClipboardItem
																				> extends true
																					? globalThis.ClipboardItem
																					: Identical<
																						T,
																						DOM.Clipboard
																					> extends true
																						? globalThis.Clipboard
																						: Identical<
																							T,
																							DOM.PermissionStatus
																						> extends true
																							? globalThis.PermissionStatus
																							: Identical<
																								T,
																								DOM.Permissions
																							> extends true
																								? globalThis.Permissions
																								: Identical<
																									T,
																									DOM.DOMStringList
																								> extends true
																									? globalThis.DOMStringList
																									: Identical<
																										T,
																										DOM.Location
																									> extends true
																										? globalThis.Location
																										: T;
type ToPlatform<T> = T extends unknown
	? T extends DOM.NodeListOf<infer U>
		? Identical<T, DOM.NodeListOf<U>> extends true
			? globalThis.NodeListOf<
				ToPlatform<U> extends infer V extends globalThis.Node ? V : never
			>
			: Map0<T>
		: T extends DOM.HTMLCollectionOf<infer U>
			? Identical<T, DOM.HTMLCollectionOf<U>> extends true
				? globalThis.HTMLCollectionOf<
					ToPlatform<U> extends infer V extends globalThis.Element ? V : never
				>
				: Map0<T>
			: T extends Array<infer U>
				? Array<ToPlatform<U>>
				: T extends ReadonlyArray<infer U>
					? ReadonlyArray<ToPlatform<U>>
					: T extends Promise<infer U>
						? Promise<ToPlatform<U>>
						: T extends (...args: infer A) => infer R
							? (...args: ToPlatformTuple<A>) => ToPlatform<R>
							: Map0<T>
	: never;
type ToPlatformTuple<
	T extends readonly unknown[],
> = {[I in keyof T]: ToPlatform<
	T[I]
>};
type Keys<G> = Exclude<keyof G, symbol>;
type Fn = (...args: never[]) => unknown;
// Up to six overloads, most recent last, as TypeScript's `infer` on a
// function type resolves one signature at a time.
type Overloads<T> = T extends {
	(...a: infer A1): infer R1;
	(...a: infer A2): infer R2;
	(...a: infer A3): infer R3;
	(...a: infer A4): infer R4;
	(...a: infer A5): infer R5;
	(...a: infer A6): infer R6;
	(...a: infer A7): infer R7;
	(...a: infer A8): infer R8;
}
	? [
		[A1, R1],
		[A2, R2],
		[A3, R3],
		[A4, R4],
		[A5, R5],
		[A6, R6],
		[A7, R7],
		[A8, R8],
	]
	: T extends {
		(...a: infer A1): infer R1;
		(...a: infer A2): infer R2;
		(...a: infer A3): infer R3;
		(...a: infer A4): infer R4;
		(...a: infer A5): infer R5;
		(...a: infer A6): infer R6;
		(...a: infer A7): infer R7;
	}
		? [[A1, R1], [A2, R2], [A3, R3], [A4, R4], [A5, R5], [A6, R6], [A7, R7]]
		: T extends {
			(...a: infer A1): infer R1;
			(...a: infer A2): infer R2;
			(...a: infer A3): infer R3;
			(...a: infer A4): infer R4;
			(...a: infer A5): infer R5;
			(...a: infer A6): infer R6;
		}
			? [[A1, R1], [A2, R2], [A3, R3], [A4, R4], [A5, R5], [A6, R6]]
			: T extends {
				(...a: infer A1): infer R1;
				(...a: infer A2): infer R2;
				(...a: infer A3): infer R3;
				(...a: infer A4): infer R4;
				(...a: infer A5): infer R5;
			}
				? [[A1, R1], [A2, R2], [A3, R3], [A4, R4], [A5, R5]]
				: T extends {
					(...a: infer A1): infer R1;
					(...a: infer A2): infer R2;
					(...a: infer A3): infer R3;
					(...a: infer A4): infer R4;
				}
					? [[A1, R1], [A2, R2], [A3, R3], [A4, R4]]
					: T extends {
						(...a: infer A1): infer R1;
						(...a: infer A2): infer R2;
						(...a: infer A3): infer R3;
					}
						? [[A1, R1], [A2, R2], [A3, R3]]
						: T extends {(...a: infer A1): infer R1; (...a: infer A2): infer R2}
							? [[A1, R1], [A2, R2]]
							: T extends (...a: infer A1) => infer R1
								? [[A1, R1]]
								: never;
type MapOverloads<T extends Array<[unknown[], unknown]>> = {
	[I in keyof T]: [ToPlatformTuple<T[I][0]>, ToPlatform<T[I][1]>];
};
type MemberDrift<A, B> = [A] extends [Fn]
	? [B] extends [Fn]
		? Identical<MapOverloads<Overloads<A>>, Overloads<B>> extends true
			? false
			: true
		: true
	: Identical<ToPlatform<A>, B> extends true ? false : true;
export type Drift<C, G, Allowed extends string = never> = Exclude<{
	[K in Keys<G>]: K extends keyof C
		? (MemberDrift<C[K], G[K]> extends true ? K : never)
		: K;
}[Keys<G>], Allowed>;

// Members that differ from lib.dom on purpose. Each is the HTML Standard
// ahead of lib.dom's copy of it.
type SpecAhead = "showPopover" | "togglePopover";
export type Extra<C, G> = Exclude<Exclude<keyof C, symbol>, keyof G>;

export type EventDrift = Drift<DOM.Event, globalThis.Event>;
export type CustomEventDrift = Drift<DOM.CustomEvent, globalThis.CustomEvent>;
export type BeforeUnloadEventDrift = Drift<
	DOM.BeforeUnloadEvent,
	globalThis.BeforeUnloadEvent
>;
export type MessageEventDrift = Drift<
	DOM.MessageEvent,
	globalThis.MessageEvent
>;
export type HashChangeEventDrift = Drift<
	DOM.HashChangeEvent,
	globalThis.HashChangeEvent
>;
export type StorageEventDrift = Drift<
	DOM.StorageEvent,
	globalThis.StorageEvent
>;
export type UIEventDrift = Drift<DOM.UIEvent, globalThis.UIEvent>;
export type MouseEventDrift = Drift<DOM.MouseEvent, globalThis.MouseEvent>;
export type FocusEventDrift = Drift<DOM.FocusEvent, globalThis.FocusEvent>;
export type KeyboardEventDrift = Drift<
	DOM.KeyboardEvent,
	globalThis.KeyboardEvent
>;
export type CompositionEventDrift = Drift<
	DOM.CompositionEvent,
	globalThis.CompositionEvent
>;
export type TextEventDrift = Drift<DOM.TextEvent, globalThis.TextEvent>;
export type InputEventDrift = Drift<DOM.InputEvent, globalThis.InputEvent>;
export type FileListDrift = Drift<DOM.FileList, globalThis.FileList>;
export type DataTransferItemDrift = Drift<
	DOM.DataTransferItem,
	globalThis.DataTransferItem
>;
export type DataTransferItemListDrift = Drift<
	DOM.DataTransferItemList,
	globalThis.DataTransferItemList
>;
export type DataTransferDrift = Drift<
	DOM.DataTransfer,
	globalThis.DataTransfer
>;
export type ClipboardEventDrift = Drift<
	DOM.ClipboardEvent,
	globalThis.ClipboardEvent
>;
export type TransitionEventDrift = Drift<
	DOM.TransitionEvent,
	globalThis.TransitionEvent
>;
export type AnimationEventDrift = Drift<
	DOM.AnimationEvent,
	globalThis.AnimationEvent
>;
export type WheelEventDrift = Drift<DOM.WheelEvent, globalThis.WheelEvent>;
export type PointerEventDrift = Drift<
	DOM.PointerEvent,
	globalThis.PointerEvent
>;
export type DragEventDrift = Drift<DOM.DragEvent, globalThis.DragEvent>;
export type EventTargetDrift = Drift<DOM.EventTarget, globalThis.EventTarget>;
export type NodeDrift = Drift<DOM.Node, globalThis.Node>;
export type MutationRecordDrift = Drift<
	DOM.MutationRecord,
	globalThis.MutationRecord
>;
export type MutationObserverDrift = Drift<
	DOM.MutationObserver,
	globalThis.MutationObserver
>;
export type NodeListDrift = Drift<DOM.NodeList, globalThis.NodeList>;
export type HTMLCollectionDrift = Drift<
	DOM.HTMLCollection,
	globalThis.HTMLCollection
>;
export type DOMTokenListDrift = Drift<
	DOM.DOMTokenList,
	globalThis.DOMTokenList
>;
export type CharacterDataDrift = Drift<
	DOM.CharacterData,
	globalThis.CharacterData
>;
export type TextDrift = Drift<DOM.Text, globalThis.Text>;
export type CDATASectionDrift = Drift<
	DOM.CDATASection,
	globalThis.CDATASection
>;
export type CommentDrift = Drift<DOM.Comment, globalThis.Comment>;
export type ProcessingInstructionDrift = Drift<
	DOM.ProcessingInstruction,
	globalThis.ProcessingInstruction
>;
export type DocumentTypeDrift = Drift<
	DOM.DocumentType,
	globalThis.DocumentType
>;
export type DocumentFragmentDrift = Drift<
	DOM.DocumentFragment,
	globalThis.DocumentFragment
>;
export type AttrDrift = Drift<DOM.Attr, globalThis.Attr>;
export type NamedNodeMapDrift = Drift<
	DOM.NamedNodeMap,
	globalThis.NamedNodeMap
>;
export type ElementDrift = Drift<DOM.Element, globalThis.Element>;
export type HTMLElementDrift = Drift<
	DOM.HTMLElement,
	globalThis.HTMLElement,
	SpecAhead
>;
export type HTMLUnknownElementDrift = Drift<
	DOM.HTMLUnknownElement,
	globalThis.HTMLUnknownElement,
	SpecAhead
>;
export type SVGElementDrift = Drift<DOM.SVGElement, globalThis.SVGElement>;
export type MathMLElementDrift = Drift<
	DOM.MathMLElement,
	globalThis.MathMLElement
>;
export type CustomElementRegistryDrift = Drift<
	DOM.CustomElementRegistry,
	globalThis.CustomElementRegistry
>;
export type ShadowRootDrift = Drift<DOM.ShadowRoot, globalThis.ShadowRoot>;
export type HTMLSlotElementDrift = Drift<
	DOM.HTMLSlotElement,
	globalThis.HTMLSlotElement,
	SpecAhead
>;
export type HTMLTemplateElementDrift = Drift<
	DOM.HTMLTemplateElement,
	globalThis.HTMLTemplateElement,
	SpecAhead
>;
export type HTMLAnchorElementDrift = Drift<
	DOM.HTMLAnchorElement,
	globalThis.HTMLAnchorElement,
	SpecAhead
>;
export type HTMLAreaElementDrift = Drift<
	DOM.HTMLAreaElement,
	globalThis.HTMLAreaElement,
	SpecAhead
>;
export type HTMLBaseElementDrift = Drift<
	DOM.HTMLBaseElement,
	globalThis.HTMLBaseElement,
	SpecAhead
>;
export type HTMLBodyElementDrift = Drift<
	DOM.HTMLBodyElement,
	globalThis.HTMLBodyElement,
	SpecAhead
>;
export type HTMLBRElementDrift = Drift<
	DOM.HTMLBRElement,
	globalThis.HTMLBRElement,
	SpecAhead
>;
export type HTMLButtonElementDrift = Drift<
	DOM.HTMLButtonElement,
	globalThis.HTMLButtonElement,
	SpecAhead
>;
export type HTMLCanvasElementDrift = Drift<
	DOM.HTMLCanvasElement,
	globalThis.HTMLCanvasElement,
	SpecAhead
>;
export type HTMLDataElementDrift = Drift<
	DOM.HTMLDataElement,
	globalThis.HTMLDataElement,
	SpecAhead
>;
export type HTMLDataListElementDrift = Drift<
	DOM.HTMLDataListElement,
	globalThis.HTMLDataListElement,
	SpecAhead
>;
export type HTMLDetailsElementDrift = Drift<
	DOM.HTMLDetailsElement,
	globalThis.HTMLDetailsElement,
	SpecAhead
>;
export type ToggleEventDrift = Drift<DOM.ToggleEvent, globalThis.ToggleEvent>;
export type HTMLDialogElementDrift = Drift<
	DOM.HTMLDialogElement,
	globalThis.HTMLDialogElement,
	SpecAhead
>;
export type HTMLDirectoryElementDrift = Drift<
	DOM.HTMLDirectoryElement,
	globalThis.HTMLDirectoryElement,
	SpecAhead
>;
export type HTMLDivElementDrift = Drift<
	DOM.HTMLDivElement,
	globalThis.HTMLDivElement,
	SpecAhead
>;
export type HTMLDListElementDrift = Drift<
	DOM.HTMLDListElement,
	globalThis.HTMLDListElement,
	SpecAhead
>;
export type HTMLEmbedElementDrift = Drift<
	DOM.HTMLEmbedElement,
	globalThis.HTMLEmbedElement,
	SpecAhead
>;
export type HTMLFieldSetElementDrift = Drift<
	DOM.HTMLFieldSetElement,
	globalThis.HTMLFieldSetElement,
	SpecAhead
>;
export type HTMLFontElementDrift = Drift<
	DOM.HTMLFontElement,
	globalThis.HTMLFontElement,
	SpecAhead
>;
export type HTMLFormElementDrift = Drift<
	DOM.HTMLFormElement,
	globalThis.HTMLFormElement,
	SpecAhead
>;
export type SubmitEventDrift = Drift<DOM.SubmitEvent, globalThis.SubmitEvent>;
export type HTMLFormControlsCollectionDrift = Drift<
	DOM.HTMLFormControlsCollection,
	globalThis.HTMLFormControlsCollection
>;
export type RadioNodeListDrift = Drift<
	DOM.RadioNodeList,
	globalThis.RadioNodeList
>;
export type HTMLFrameElementDrift = Drift<
	DOM.HTMLFrameElement,
	globalThis.HTMLFrameElement,
	SpecAhead
>;
export type HTMLFrameSetElementDrift = Drift<
	DOM.HTMLFrameSetElement,
	globalThis.HTMLFrameSetElement,
	SpecAhead
>;
export type HTMLHeadElementDrift = Drift<
	DOM.HTMLHeadElement,
	globalThis.HTMLHeadElement,
	SpecAhead
>;
export type HTMLHeadingElementDrift = Drift<
	DOM.HTMLHeadingElement,
	globalThis.HTMLHeadingElement,
	SpecAhead
>;
export type HTMLHRElementDrift = Drift<
	DOM.HTMLHRElement,
	globalThis.HTMLHRElement,
	SpecAhead
>;
export type HTMLHtmlElementDrift = Drift<
	DOM.HTMLHtmlElement,
	globalThis.HTMLHtmlElement,
	SpecAhead
>;
export type HTMLIFrameElementDrift = Drift<
	DOM.HTMLIFrameElement,
	globalThis.HTMLIFrameElement,
	SpecAhead
>;
export type HTMLImageElementDrift = Drift<
	DOM.HTMLImageElement,
	globalThis.HTMLImageElement,
	SpecAhead
>;
export type HTMLInputElementDrift = Drift<
	DOM.HTMLInputElement,
	globalThis.HTMLInputElement,
	SpecAhead
>;
export type HTMLLabelElementDrift = Drift<
	DOM.HTMLLabelElement,
	globalThis.HTMLLabelElement,
	SpecAhead
>;
export type HTMLLegendElementDrift = Drift<
	DOM.HTMLLegendElement,
	globalThis.HTMLLegendElement,
	SpecAhead
>;
export type HTMLLIElementDrift = Drift<
	DOM.HTMLLIElement,
	globalThis.HTMLLIElement,
	SpecAhead
>;
export type HTMLLinkElementDrift = Drift<
	DOM.HTMLLinkElement,
	globalThis.HTMLLinkElement,
	SpecAhead
>;
export type HTMLMapElementDrift = Drift<
	DOM.HTMLMapElement,
	globalThis.HTMLMapElement,
	SpecAhead
>;
export type HTMLMarqueeElementDrift = Drift<
	DOM.HTMLMarqueeElement,
	globalThis.HTMLMarqueeElement,
	SpecAhead
>;
export type HTMLMediaElementDrift = Drift<
	DOM.HTMLMediaElement,
	globalThis.HTMLMediaElement,
	SpecAhead
>;
export type HTMLAudioElementDrift = Drift<
	DOM.HTMLAudioElement,
	globalThis.HTMLAudioElement,
	SpecAhead
>;
export type HTMLVideoElementDrift = Drift<
	DOM.HTMLVideoElement,
	globalThis.HTMLVideoElement,
	SpecAhead
>;
export type HTMLMenuElementDrift = Drift<
	DOM.HTMLMenuElement,
	globalThis.HTMLMenuElement,
	SpecAhead
>;
export type HTMLMetaElementDrift = Drift<
	DOM.HTMLMetaElement,
	globalThis.HTMLMetaElement,
	SpecAhead
>;
export type HTMLMeterElementDrift = Drift<
	DOM.HTMLMeterElement,
	globalThis.HTMLMeterElement,
	SpecAhead
>;
export type HTMLModElementDrift = Drift<
	DOM.HTMLModElement,
	globalThis.HTMLModElement,
	SpecAhead
>;
export type HTMLObjectElementDrift = Drift<
	DOM.HTMLObjectElement,
	globalThis.HTMLObjectElement,
	SpecAhead
>;
export type HTMLOListElementDrift = Drift<
	DOM.HTMLOListElement,
	globalThis.HTMLOListElement,
	SpecAhead
>;
export type HTMLOptGroupElementDrift = Drift<
	DOM.HTMLOptGroupElement,
	globalThis.HTMLOptGroupElement,
	SpecAhead
>;
export type HTMLOptionElementDrift = Drift<
	DOM.HTMLOptionElement,
	globalThis.HTMLOptionElement,
	SpecAhead
>;
export type HTMLOptionsCollectionDrift = Drift<
	DOM.HTMLOptionsCollection,
	globalThis.HTMLOptionsCollection
>;
export type HTMLOutputElementDrift = Drift<
	DOM.HTMLOutputElement,
	globalThis.HTMLOutputElement,
	SpecAhead
>;
export type HTMLParagraphElementDrift = Drift<
	DOM.HTMLParagraphElement,
	globalThis.HTMLParagraphElement,
	SpecAhead
>;
export type HTMLParamElementDrift = Drift<
	DOM.HTMLParamElement,
	globalThis.HTMLParamElement,
	SpecAhead
>;
export type HTMLPictureElementDrift = Drift<
	DOM.HTMLPictureElement,
	globalThis.HTMLPictureElement,
	SpecAhead
>;
export type HTMLPreElementDrift = Drift<
	DOM.HTMLPreElement,
	globalThis.HTMLPreElement,
	SpecAhead
>;
export type HTMLProgressElementDrift = Drift<
	DOM.HTMLProgressElement,
	globalThis.HTMLProgressElement,
	SpecAhead
>;
export type HTMLQuoteElementDrift = Drift<
	DOM.HTMLQuoteElement,
	globalThis.HTMLQuoteElement,
	SpecAhead
>;
export type HTMLScriptElementDrift = Drift<
	DOM.HTMLScriptElement,
	globalThis.HTMLScriptElement,
	SpecAhead
>;
export type HTMLSelectElementDrift = Drift<
	DOM.HTMLSelectElement,
	globalThis.HTMLSelectElement,
	SpecAhead
>;
export type HTMLSourceElementDrift = Drift<
	DOM.HTMLSourceElement,
	globalThis.HTMLSourceElement,
	SpecAhead
>;
export type HTMLSpanElementDrift = Drift<
	DOM.HTMLSpanElement,
	globalThis.HTMLSpanElement,
	SpecAhead
>;
export type HTMLStyleElementDrift = Drift<
	DOM.HTMLStyleElement,
	globalThis.HTMLStyleElement,
	SpecAhead
>;
export type HTMLTableCaptionElementDrift = Drift<
	DOM.HTMLTableCaptionElement,
	globalThis.HTMLTableCaptionElement,
	SpecAhead
>;
export type HTMLTableCellElementDrift = Drift<
	DOM.HTMLTableCellElement,
	globalThis.HTMLTableCellElement,
	SpecAhead
>;
export type HTMLTableColElementDrift = Drift<
	DOM.HTMLTableColElement,
	globalThis.HTMLTableColElement,
	SpecAhead
>;
export type HTMLTableElementDrift = Drift<
	DOM.HTMLTableElement,
	globalThis.HTMLTableElement,
	SpecAhead
>;
export type HTMLTableRowElementDrift = Drift<
	DOM.HTMLTableRowElement,
	globalThis.HTMLTableRowElement,
	SpecAhead
>;
export type HTMLTableSectionElementDrift = Drift<
	DOM.HTMLTableSectionElement,
	globalThis.HTMLTableSectionElement,
	SpecAhead
>;
export type HTMLTextAreaElementDrift = Drift<
	DOM.HTMLTextAreaElement,
	globalThis.HTMLTextAreaElement,
	SpecAhead
>;
export type HTMLTimeElementDrift = Drift<
	DOM.HTMLTimeElement,
	globalThis.HTMLTimeElement,
	SpecAhead
>;
export type HTMLTitleElementDrift = Drift<
	DOM.HTMLTitleElement,
	globalThis.HTMLTitleElement,
	SpecAhead
>;
export type HTMLTrackElementDrift = Drift<
	DOM.HTMLTrackElement,
	globalThis.HTMLTrackElement,
	SpecAhead
>;
export type HTMLUListElementDrift = Drift<
	DOM.HTMLUListElement,
	globalThis.HTMLUListElement,
	SpecAhead
>;
export type DOMStringMapDrift = Drift<
	DOM.DOMStringMap,
	globalThis.DOMStringMap
>;
export type ValidityStateDrift = Drift<
	DOM.ValidityState,
	globalThis.ValidityState
>;
export type CustomStateSetDrift = Drift<
	DOM.CustomStateSet,
	globalThis.CustomStateSet
>;
export type ElementInternalsDrift = Drift<
	DOM.ElementInternals,
	globalThis.ElementInternals
>;
export type DOMRectReadOnlyDrift = Drift<
	DOM.DOMRectReadOnly,
	globalThis.DOMRectReadOnly
>;
export type DOMRectDrift = Drift<DOM.DOMRect, globalThis.DOMRect>;
export type DOMRectListDrift = Drift<DOM.DOMRectList, globalThis.DOMRectList>;
export type ResizeObserverDrift = Drift<
	DOM.ResizeObserver,
	globalThis.ResizeObserver
>;
export type IntersectionObserverDrift = Drift<
	DOM.IntersectionObserver,
	globalThis.IntersectionObserver
>;
export type DocumentDrift = Drift<DOM.Document, globalThis.Document>;
export type XMLDocumentDrift = Drift<DOM.XMLDocument, globalThis.XMLDocument>;
export type DOMImplementationDrift = Drift<
	DOM.DOMImplementation,
	globalThis.DOMImplementation
>;
export type AbstractRangeDrift = Drift<
	DOM.AbstractRange,
	globalThis.AbstractRange
>;
export type StaticRangeDrift = Drift<DOM.StaticRange, globalThis.StaticRange>;
export type RangeDrift = Drift<DOM.Range, globalThis.Range>;
export type SelectionDrift = Drift<DOM.Selection, globalThis.Selection>;
export type NodeIteratorDrift = Drift<
	DOM.NodeIterator,
	globalThis.NodeIterator
>;
export type TreeWalkerDrift = Drift<DOM.TreeWalker, globalThis.TreeWalker>;
export type DOMParserDrift = Drift<DOM.DOMParser, globalThis.DOMParser>;
export type ClipboardItemDrift = Drift<
	DOM.ClipboardItem,
	globalThis.ClipboardItem
>;
export type ClipboardDrift = Drift<DOM.Clipboard, globalThis.Clipboard>;
export type PermissionStatusDrift = Drift<
	DOM.PermissionStatus,
	globalThis.PermissionStatus
>;
export type PermissionsDrift = Drift<DOM.Permissions, globalThis.Permissions>;
export type DOMStringListDrift = Drift<
	DOM.DOMStringList,
	globalThis.DOMStringList
>;
export type LocationDrift = Drift<DOM.Location, globalThis.Location>;
