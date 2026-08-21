import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

const {document} = term;
document.body.innerHTML = `
  <style>
    .chart { border: 1px solid #5fafff; padding: 0 1ch; width: 46ch; }
    .title { color: #5fafff; font-weight: bold; }
    .row { display: flex; }
    .label { width: 10ch; color: #888; }
    .bar { background-color: #5fafff; }
    .row:nth-of-type(2) .bar { background-color: green; }
    .row:nth-of-type(3) .bar { background-color: #cc99cd; }
    .row:nth-of-type(4) .bar { background-color: #f0a45d; }
    .value { margin-left: 1ch; color: #888; }
  </style>
  <div class="chart">
    <div class="title">Requests per region</div>
  </div>
`;

const chart = document.querySelector(".chart")!;
const regions = [
	{name: "us-east", requests: 18},
	{name: "eu-west", requests: 12},
	{name: "ap-south", requests: 7},
	{name: "sa-east", requests: 3},
];

const bars = regions.map((region) => {
	const row = document.createElement("div");
	row.className = "row";
	row.innerHTML = `
		<span class="label">${region.name}</span>
		<div class="bar"></div>
		<span class="value"></span>
	`;
	chart.appendChild(row);
	return {
		region,
		bar: row.querySelector(".bar") as HTMLElement,
		value: row.querySelector(".value") as HTMLElement,
	};
});

setInterval(() => {
	for (const {region, bar, value} of bars) {
		region.requests = Math.max(
			1,
			Math.min(24, region.requests + Math.floor(Math.random() * 3) - 1),
		);
		bar.style.width = region.requests + "ch";
		value.textContent = String(region.requests * 41);
	}
}, 300);
