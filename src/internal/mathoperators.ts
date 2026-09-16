/**
 * The MathML Core operator dictionary, compressed by category. Each
 * category names a form, the spacing on each side in eighteenths of an
 * em, the properties every operator in it shares, and the operators.
 */

export type OperatorForm = "prefix" | "infix" | "postfix";

export interface OperatorEntry {
	form: OperatorForm;
	lspace: number;
	rspace: number;
	stretchy: boolean;
	symmetric: boolean;
	largeop: boolean;
	accent: boolean;
	movableLimits: boolean;
}

type Category = [
	form: OperatorForm,
	lspace: number,
	rspace: number,
	flags: string,
	operators: string,
];

const CATEGORIES: Category[] = [
	[
		"infix",
		5,
		5,
		"",
		"= < > ≠ ≤ ≥ ≡ ≢ ≈ ≉ ≃ ≄ ≅ ≆ ≇ ≍ ≎ ≏ ≐ ≑ ≒ ≓ ≔ ≕ ≖ ≗ ≘ ≙ ≚ ≛ ≜ ≝ ≞ ≟ " +
		"≦ ≧ ≨ ≩ ≪ ≫ ≬ ≭ ≮ ≯ ≰ ≱ ≲ ≳ ≴ ≵ ≶ ≷ ≸ ≹ ≺ ≻ ≼ ≽ ≾ ≿ ⊀ ⊁ ⊂ ⊃ ⊄ ⊅ ⊆ ⊇ ⊈ ⊉ " +
		"⊊ ⊋ ⊏ ⊐ ⊑ ⊒ ⊢ ⊣ ⊤ ⊥ ⊦ ⊧ ⊨ ⊩ ⊪ ⊫ ⊬ ⊭ ⊮ ⊯ ⊰ ⊱ ⊲ ⊳ ⊴ ⊵ ⊶ ⊷ ⋍ ⋐ ⋑ ⋖ ⋗ ⋘ ⋙ " +
		"⋚ ⋛ ⋜ ⋝ ⋞ ⋟ ⋠ ⋡ ⋢ ⋣ ⋤ ⋥ ⋦ ⋧ ⋨ ⋩ ⋪ ⋫ ⋬ ⋭ ∈ ∉ ∊ ∋ ∌ ∍ ∝ ∣ ∤ ∥ ∦ ∼ ∽ ∾ ∿ ≀ ≁ " +
		": ∶ ∷ ⊏ ⊐ ⫅ ⫆ ⫋ ⫌ ⩽ ⩾ ⪅ ⪆ ⪇ ⪈ ⪉ ⪊ ⪋ ⪌ ⪕ ⪖ ⪯ ⪰ ⪷ ⪸ ⩵ ⩶ ⩸ ⫫ ⫬",
	],
	[
		"infix",
		5,
		5,
		"stretchy",
		"← ↑ → ↓ ↔ ↕ ↖ ↗ ↘ ↙ ↚ ↛ ↞ ↠ ↢ ↣ ↦ ↩ ↪ ↫ ↬ ↭ ↮ ↰ ↱ ↶ ↷ ↺ ↻ ↼ ↽ ↾ ↿ ⇀ ⇁ ⇂ ⇃ " +
		"⇄ ⇅ ⇆ ⇇ ⇈ ⇉ ⇊ ⇋ ⇌ ⇍ ⇎ ⇏ ⇐ ⇑ ⇒ ⇓ ⇔ ⇕ ⇖ ⇗ ⇘ ⇙ ⇚ ⇛ ⇝ ⇞ ⇟ ⇠ ⇡ ⇢ ⇣ ⇤ ⇥ ⇦ ⇧ ⇨ ⇩ " +
		"⇪ ⟵ ⟶ ⟷ ⟸ ⟹ ⟺ ⟻ ⟼ ⟽ ⟾ ⟿ ⤒ ⤓ ⥊ ⥋ ⥎ ⥐ ⥒ ⥓ ⥖ ⥗ ⥚ ⥛ ⥞ ⥟ ⥢ ⥤ ⥦ ⥧ ⥨ ⥩ ⥪ ⥫ ⥬ ⥭ ⥮ ⥯",
	],
	[
		"infix",
		4,
		4,
		"",
		"+ − - ± ∓ ∔ ∸ ∨ ∧ ⊕ ⊖ ⊎ ⊔ ⊓ ∪ ∩ ⋃ ⋂ ⊻ ⊼ ⊽ ⋎ ⋏ ⩒ ⩓ ⩔ ⩕ ⩖ ⩗ ⩘ ⩙ ⩚ ⩛ ⩜ ⩝ " +
		"⩞ ⩟ ⩠ ⩡ ⩢ ⩣ ⩤ ⩥ ⩦ ⩧ ⩨ ⩩ ⩪ ⩫ ⩬ ⩭ ⩮ ⩯ ⩰ ⩱ ⩲ ⩳ ⩴ ⨢ ⨣ ⨤ ⨥ ⨦ ⨧ ⨨ ⨩ ⨪ ⨫ ⨬ ⨭ ⨮ ⨹ ⨺",
	],
	[
		"infix",
		3,
		3,
		"",
		"× ⋅ · ∗ ∘ ∙ ⊗ ⊘ ⊙ ⊚ ⊛ ⊜ ⊝ ⊞ ⊟ ⊠ ⊡ ⋄ ⋆ ⋇ ⋈ ⋉ ⋊ ⋋ ⋌ ⋒ ⋓ ∖ ⁄ / ÷ ∤ ∦ % ‰ ‱ " +
		"⊗ ⨯ ⨰ ⨱ ⨲ ⨳ ⨴ ⨵ ⨶ ⨷ ⨸ ⨻ ⨼ ⨽ ⩀ ⩁ ⩂ ⩃ ⩄ ⩅ ⩆ ⩇ ⩈ ⩉ ⩊ ⩋ ⩌ ⩍ ⩎ ⩏ ⩐ ⩑ ∧ ∨ ∘ ∙ ⋅ ⊙ " +
		"@ & * . ^ ⃒ ⧵ ⨿",
	],
	["infix", 0, 3, "", ", ; "],
	["infix", 0, 0, "", "⁡ ⁢ ⁣ ⁤ ​ ' ′ ″ ‴ ⁗"],
	[
		"prefix",
		0,
		0,
		"stretchy symmetric",
		"( [ { ⌈ ⌊ ⟨ ⟦ ⟪ ⟬ ⟮ ⦃ ⦅ ⦇ ⦉ ⦋ ⦍ ⦏ ⦑ ⦓ ⦕ ⦗ ⧼ | ‖ ⎰ ⎱ ⟅ ⟨ ⦇ ⦉",
	],
	[
		"postfix",
		0,
		0,
		"stretchy symmetric",
		") ] } ⌉ ⌋ ⟩ ⟧ ⟫ ⟭ ⟯ ⦄ ⦆ ⦈ ⦊ ⦌ ⦎ ⦐ ⦒ ⦔ ⦖ ⦘ ⧽ | ‖ ⎱ ⟆ ⦈ ⦊",
	],
	[
		"prefix",
		3,
		3,
		"stretchy largeop symmetric movablelimits",
		"∑ ∏ ∐ ⋀ ⋁ ⋂ ⋃ ⨀ ⨁ ⨂ ⨃ ⨄ ⨅ ⨆ ⨇ ⨈ ⨉ ⫼ ⫽ ⫿",
	],
	[
		"prefix",
		3,
		0,
		"stretchy largeop symmetric",
		"∫ ∬ ∭ ∮ ∯ ∰ ∱ ∲ ∳ ⨋ ⨌ ⨍ ⨎ ⨏ ⨐ ⨑ ⨒ ⨓ ⨔ ⨕ ⨖ ⨗ ⨘ ⨙ ⨚ ⨛ ⨜",
	],
	["prefix", 0, 0, "movablelimits", "lim max min sup inf det gcd Pr"],
	[
		"prefix",
		0,
		0,
		"",
		"+ − - ± ∓ ¬ ∂ ∇ √ ∛ ∜ ∀ ∃ ∄ ∁ ∆ ∡ ∢ ∟ ∠ ℑ ℜ ℘ ∤ ∦ ⊘ ∽ ∾ ∿ ⅁ ⅂ ⅃ ⅄ ⅋ ⨊ ⫝̸ ⫝ ⫞ ⫟ ⫠",
	],
	["postfix", 0, 0, "", "! ′ ″ ‴ ⁗ ° ‰ ‱ ‼ ⁇ ⁈ ⁉ ′′ ′′′"],
	[
		"postfix",
		0,
		0,
		"accent stretchy",
		"^ ˆ ˇ ˉ ˊ ˋ ˍ ˘ ˙ ˚ ˜ ˝ ¯ ´ ` ¨ ¸ ~ _ ‾ ‿ ⁀ ⃗ ⏜ ⏝ ⏞ ⏟ ⏠ ⏡ ⎴ ⎵ ⎶ ← → ↔ ↼ ⇀ ⇐ ⇒ ⇔ " +
		"⟵ ⟶ ⟷ ─ ‐ ‑ ‒ – —",
	],
	["postfix", 0, 0, "accent", "̂ ̃ ̄ ̅ ̇ ̈ ̌ ̆ ̊ ̀ ́ ⃗ ̲ ̱ ̣ ̧ ̸ ̶ ̷"],
];

const FORM_ORDER: OperatorForm[] = ["infix", "postfix", "prefix"];

const DICTIONARY = new Map<string, OperatorEntry>();

for (const [form, lspace, rspace, flags, operators] of CATEGORIES) {
	const entry: OperatorEntry = {
		form,
		lspace,
		rspace,
		stretchy: flags.includes("stretchy"),
		symmetric: flags.includes("symmetric"),
		largeop: flags.includes("largeop"),
		accent: flags.includes("accent"),
		movableLimits: flags.includes("movablelimits"),
	};
	for (const operator of operators.split(" ")) {
		if (operator === "") {
			continue;
		}
		const key = `${form} ${operator}`;
		if (!DICTIONARY.has(key)) {
			DICTIONARY.set(key, entry);
		}
	}
}

/**
 * The dictionary entry for an operator in a form. When the form has no
 * entry the other forms are tried in the order the spec gives, and an
 * operator in no form at all gets the spec's fallback: the requested
 * form, 5/18 em on each side, and no properties.
 */
export function lookupOperator(
	text: string,
	form: OperatorForm,
): OperatorEntry {
	const own = DICTIONARY.get(`${form} ${text}`);
	if (own) {
		return own;
	}
	for (const candidate of FORM_ORDER) {
		const entry = DICTIONARY.get(`${candidate} ${text}`);
		if (entry) {
			return {...entry, form};
		}
	}
	return {
		form,
		lspace: 5,
		rspace: 5,
		stretchy: false,
		symmetric: false,
		largeop: false,
		accent: false,
		movableLimits: false,
	};
}
