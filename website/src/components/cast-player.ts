import {jsx} from "@b9g/crank/standalone";
import {css} from "@emotion/css";

export interface CastPlayerProps {
	/** URL of the .cast file, from the static assets map. */
	src: string;
	/** Terminal rows to reserve, so the box does not resize on load. */
	rows?: number;
	cols?: number;
	caption?: string;
	autoplay?: boolean;
	loop?: boolean;
	idleTimeLimit?: number;
}

/**
 * A recorded terminal session.
 *
 * The server renders an empty, correctly-sized box carrying its settings as
 * data attributes; the client entry finds those boxes and mounts the player.
 * Sizing the box up front is the point -- the recording knows its own
 * dimensions, so the page can reserve exactly the right space and never
 * reflow when the player arrives.
 */
export function CastPlayer({
	src,
	rows = 24,
	cols = 78,
	caption,
	autoplay = true,
	loop = true,
	idleTimeLimit = 1.5,
}: CastPlayerProps) {
	// The player's own line height, near enough for reservation purposes.
	const heightEm = rows * 1.33;

	return jsx`
		<figure class=${css`
			margin: 1.5rem 0;
		`}>
			<div
				class="cast-player"
				data-cast-src=${src}
				data-cast-cols=${String(cols)}
				data-cast-rows=${String(rows)}
				data-cast-autoplay=${autoplay ? "1" : "0"}
				data-cast-loop=${loop ? "1" : "0"}
				data-cast-idle=${String(idleTimeLimit)}
				style=${`min-height: ${heightEm}ex;`}
			></div>
			${
				caption &&
				jsx`
					<figcaption class=${css`
						margin-top: 0.5rem;
						font-size: 0.8rem;
						color: var(--muted-color);
						text-align: center;
					`}>${caption}</figcaption>
				`
			}
		</figure>
	`;
}
