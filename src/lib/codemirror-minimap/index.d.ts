import { Facet } from '@codemirror/state';
import { DOMEventMap, EditorView } from '@codemirror/view';

type Line = number;
type Color = string;
type Gutter = Record<Line, Color>;

type EventHandler<event extends keyof DOMEventMap> = (e: DOMEventMap[event], v: EditorView) => void;
type Options = {
    enabled: boolean;
    /**
     * Determines how to render text. Defaults to `characters`.
     */
    displayText?: "blocks" | "characters";
    /**
     * Attach event handlers to the minimap container element.
     */
    eventHandlers?: {
        [event in keyof DOMEventMap]?: EventHandler<event>;
    };
    /**
     * The overlay shows the portion of the file currently in the viewport.
     * Defaults to `always`.
     */
    showOverlay?: "always" | "mouse-over";
    /**
     * Enables a gutter to be drawn on the given line to the left
     * of the minimap, with the given color. Accepts all valid CSS
     * color values.
     */
    gutters?: Array<Gutter>;
    /**
     * Override the minimap width in pixels. Defaults to the
     * package's built-in scaling (capped at 120px).
     */
    width?: number;
};

interface MinimapConfig extends Omit<Options, "enabled"> {
    /**
     * A function that creates the element that contains the minimap
     */
    create: (view: EditorView) => {
        dom: HTMLElement;
    };
}
/**
 * Facet used to show a minimap in the right gutter of the editor using the
 * provided configuration.
 *
 * If you return `null`, a minimap will not be shown.
 */
declare const showMinimap: Facet<MinimapConfig | null, MinimapConfig | null>;

export { MinimapConfig, showMinimap };
