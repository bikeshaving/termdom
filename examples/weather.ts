// A weather report from Open-Meteo (no API key), drawn with emoji
//
//   node examples/weather.ts            (opens with the search focused)
//   node examples/weather.ts Tokyo      (searches immediately)
//
//   type a city and Enter searches      /  focuses the search again
//   arrows (or a click) chart a day     u  toggles °C and °F
//   q  quits (while not typing)
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {TermDOM} from "@b9g/termdom";

// The last successful search, kept in the platform's state directory so a
// bare launch reopens on the city you looked at last.
const STATE_DIR = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"termdom-weather",
);
const CITY_FILE = join(STATE_DIR, "city");

function rememberCity(name: string): void {
	try {
		mkdirSync(STATE_DIR, {recursive: true});
		writeFileSync(CITY_FILE, name);
	} catch {
		// A read-only home just means the city is forgotten.
	}
}

function rememberedCity(): string | null {
	try {
		return readFileSync(CITY_FILE, "utf8").trim() || null;
	} catch {
		return null;
	}
}

const term = new TermDOM();
term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	.title { color: cyan; font-weight: bold; }
	.hint { color: #666666; margin-bottom: 1px; }
	.prompt { display: flex; flex-direction: row; }
	.prompt .sigil { color: #ff8700; font-weight: bold; }
	input { border: none; padding: 0; flex-grow: 1; }
	.status { color: #808080; margin-top: 1px; }
	.error { color: #ff5f5f; margin-top: 1px; }
	.place { font-weight: bold; margin-top: 1px; }
	.place .region { font-weight: normal; color: #808080; }
	.now { display: flex; flex-direction: row; margin-top: 1px; }
	.now .glyph { font-size: inherit; }
	.now .temp { font-weight: bold; color: #ffd75f; }
	.now .desc { color: #87d787; }
	.now > * { margin-right: 2ch; }
	.days { display: flex; flex-direction: row; margin-top: 1px; }
	.day { border: 1px solid #444444; padding: 0 1ch; margin-right: 1ch;
	       display: flex; flex-direction: column; align-items: center; }
	.day .name { color: #5fafff; }
	.day .hi { color: #ffd75f; }
	.day .lo { color: #808080; }
	.day.on { border-color: #ffd75f; }
	.day.on .name { color: #ffd75f; }
	.chart { margin-top: 1px; white-space: pre; }
	.chart .label { color: #808080; }
	.chart .t0 { color: #00d7ff; }
	.chart .t1 { color: #5fafff; }
	.chart .t2 { color: #ffffff; }
	.chart .t3 { color: #ffd75f; }
	.chart .t4 { color: #ff8700; }
	.chart .t5 { color: #ff5f5f; }
	.chart .rain { color: #5fafff; }
	.chart .axis { color: #666666; }
`;
document.head.appendChild(style);

document.body.innerHTML = `
	<div class="title"> weather</div>
	<div class="hint"> Enter search · / search again · ←→ chart a day · [u]nits · [q]uit</div>
	<div class="prompt"><span class="sigil">⌂ </span><input placeholder="city…"></div>
	<div id="report"></div>
`;
const input = document.querySelector("input")!;
const report = document.getElementById("report")!;

// WMO weather interpretation codes, as Open-Meteo reports them.
const GLYPHS: Array<[Set<number>, string, string]> = [
	[new Set([0]), "☀️", "clear"],
	[new Set([1]), "🌤️", "mostly clear"],
	[new Set([2]), "⛅️", "partly cloudy"],
	[new Set([3]), "☁️", "overcast"],
	[new Set([45, 48]), "🌫️", "fog"],
	[new Set([51, 53, 55, 56, 57]), "🌦️", "drizzle"],
	[new Set([61, 63, 65, 66, 67, 80, 81, 82]), "🌧️", "rain"],
	[new Set([71, 73, 75, 77, 85, 86]), "🌨️", "snow"],
	[new Set([95, 96, 99]), "⛈️", "thunderstorm"],
];

function glyphFor(code: number): [string, string] {
	for (const [codes, glyph, name] of GLYPHS) {
		if (codes.has(code)) return [glyph, name];
	}
	return ["🌡️", `code ${code}`];
}

/** The eight compass arrows, pointing where the wind blows toward. */
function windArrow(fromDegrees: number): string {
	const toward = (fromDegrees + 180) % 360;
	return "↑↗→↘↓↙←↖"[Math.round(toward / 45) % 8];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let celsius = true;
let lastPlace: {name: string; region: string; lat: number; lon: number} | null =
	null;
let searchGeneration = 0;
let dayIndex = 0;
let lastData: Forecast | null = null;

function show(kind: "status" | "error", text: string): void {
	report.innerHTML = `<div class="${kind}"></div>`;
	report.firstElementChild!.textContent = ` ${text}`;
}

async function search(query: string): Promise<void> {
	const generation = ++searchGeneration;
	show("status", `looking up ${query}…`);
	try {
		const geo = await fetch(
			"https://geocoding-api.open-meteo.com/v1/search?count=1&name=" +
				encodeURIComponent(query),
		).then((res) => res.json());
		if (generation !== searchGeneration) return;
		const hit = geo.results?.[0];
		if (!hit) return show("error", `no place called ${query} found`);
		lastPlace = {
			name: hit.name,
			region: [hit.admin1, hit.country].filter(Boolean).join(", "),
			lat: hit.latitude,
			lon: hit.longitude,
		};
		rememberCity(hit.name);
		await forecast(generation);
	} catch {
		if (generation === searchGeneration) {
			show("error", "the weather is unreachable (network error)");
		}
	}
}

async function forecast(generation: number): Promise<void> {
	const place = lastPlace!;
	show("status", `fetching the weather for ${place.name}…`);
	try {
		const unit = celsius ? "celsius" : "fahrenheit";
		const data = await fetch(
			`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
				"&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m" +
				"&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=7" +
				"&daily=weather_code,temperature_2m_max,temperature_2m_min" +
				`&temperature_unit=${unit}&timezone=auto`,
		).then((res) => res.json());
		if (generation !== searchGeneration) return;
		lastData = data;
		dayIndex = 0;
		render(data);
	} catch {
		if (generation === searchGeneration) {
			show("error", "the weather is unreachable (network error)");
		}
	}
}

interface Forecast {
	current: {
		temperature_2m: number;
		apparent_temperature: number;
		weather_code: number;
		wind_speed_10m: number;
		wind_direction_10m: number;
		relative_humidity_2m: number;
	};
	hourly: {
		time: string[];
		temperature_2m: number[];
		precipitation_probability: number[];
		weather_code: number[];
	};
	daily: {
		time: string[];
		weather_code: number[];
		temperature_2m_max: number[];
		temperature_2m_min: number[];
	};
}

/** The color bucket a temperature paints with, coldest to hottest. */
function bucketOf(temp: number): string {
	const c = celsius ? temp : ((temp - 32) * 5) / 9;
	if (c < 0) return "t0";
	if (c < 10) return "t1";
	if (c < 20) return "t2";
	if (c < 28) return "t3";
	if (c < 35) return "t4";
	return "t5";
}

const EIGHTHS = " ▁▂▃▄▅▆▇█";

/**
 * A block-glyph bar chart, one column per hour: full blocks up to the
 * value, an eighth-block remainder at the top, colored by temperature.
 */
function temperatureChart(temps: number[]): string {
	const min = Math.min(...temps);
	const max = Math.max(...temps);
	const span = Math.max(1, max - min);
	const ROWS = 4;
	const lines: string[] = [];
	for (let row = ROWS - 1; row >= 0; row--) {
		const cells = temps
			.map((t) => {
				// The floor is half a block, not an eighth: the day's minimum is
				// still a temperature, and an eighth-block reads as a hole.
				const eighths = Math.round(((t - min) / span) * (ROWS * 8 - 4)) + 4;
				const level = Math.max(0, Math.min(8, eighths - row * 8));
				return `<span class="${bucketOf(t)}">${EIGHTHS[level]}</span>`;
			})
			.join("");
		const label =
			row === ROWS - 1
				? String(Math.round(max)).padStart(4) + "° "
				: row === 0
					? String(Math.round(min)).padStart(4) + "° "
					: "      ";
		lines.push(`<div><span class="label">${label}</span>${cells}</div>`);
	}
	return lines.join("");
}

/**
 * The sky by hour as emoji -- sun cover, cloud, rain. Every second hour,
 * because an emoji is two cells wide and the bars above are one per hour.
 */
function skyRow(codes: number[]): string {
	const glyphs = codes
		.filter((_, i) => i % 2 === 0)
		.map((code) => glyphFor(code)[0])
		.join("");
	return `<div><span class="label">      </span>${glyphs}</div>`;
}

function render(data: Forecast): void {
	const place = lastPlace!;
	const degrees = celsius ? "°C" : "°F";
	const now = data.current;
	const [glyph, description] = glyphFor(now.weather_code);
	const days = data.daily.time
		.map((iso, i) => {
			const name = i === 0 ? "today" : DAY_NAMES[new Date(iso).getUTCDay()];
			const [dayGlyph] = glyphFor(data.daily.weather_code[i]);
			// The spans sit flush together: whitespace between them would become
			// anonymous rows inside the column flex card.
			return `<div class="day${i === dayIndex ? " on" : ""}"><span class="name">${name}</span><span>${dayGlyph}</span><span class="hi">${Math.round(data.daily.temperature_2m_max[i])}°</span><span class="lo">${Math.round(data.daily.temperature_2m_min[i])}°</span></div>`;
		})
		.join("");
	report.innerHTML = `
		<div class="place"> ${place.name} <span class="region">${place.region}</span></div>
		<div class="now">
			<span class="glyph">${glyph}</span>
			<span class="temp">${Math.round(now.temperature_2m)}${degrees}</span>
			<span class="desc">${description}</span>
			<span>feels ${Math.round(now.apparent_temperature)}°</span>
			<span>💨 ${windArrow(now.wind_direction_10m)} ${Math.round(now.wind_speed_10m)} km/h</span>
			<span>💧 ${now.relative_humidity_2m}%</span>
		</div>
		<div class="days">${days}</div>
		<div class="chart">${temperatureChart(
			data.hourly.temperature_2m.slice(dayIndex * 24, dayIndex * 24 + 24),
		)}${skyRow(
			data.hourly.weather_code.slice(dayIndex * 24, dayIndex * 24 + 24),
		)}<div class="axis"><span class="label">      </span>0     6     12    18</div></div>
	`;
}

input.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key === "Enter") {
		const query = (input as HTMLInputElement).value.trim();
		if (query) void search(query);
	}
});

document.addEventListener("keydown", (event) => {
	const key = (event as KeyboardEvent).key;
	if ((event.target as Element)?.tagName === "INPUT") return;
	if (key === "q") term.window.close();
	if (key === "/") (input as HTMLElement).focus();
	if (key === "u") {
		celsius = !celsius;
		if (lastPlace) void forecast(++searchGeneration);
	}
	if (key === "ArrowLeft" || key === "ArrowRight") {
		if (!lastData) return;
		const count = lastData.daily.time.length;
		dayIndex = (dayIndex + (key === "ArrowRight" ? 1 : -1) + count) % count;
		render(lastData);
	}
});

// A click on a day card charts that day.
report.addEventListener("click", (event) => {
	const card = (event.target as Element | null)?.closest?.(".day");
	if (!card || !lastData) return;
	dayIndex = Array.from(card.parentElement!.children).indexOf(card);
	render(lastData);
});

const opening = process.argv[2] ?? rememberedCity();
if (opening) {
	(input as HTMLInputElement).value = opening;
	void search(opening);
} else {
	(input as HTMLElement).focus();
}
