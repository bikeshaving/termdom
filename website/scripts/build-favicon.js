import svgToIco from "svg-to-ico";
await svgToIco({
	input_name: "static/logo.svg",
	output_name: "static/favicon.ico",
	sizes: [16, 32, 48, 64],
});
console.log("wrote static/favicon.ico");
