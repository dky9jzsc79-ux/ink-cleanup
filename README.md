# Ink Cleanup

A browser front end for ImageMagick and Potrace that streamlines cleaning and vectorizing scanned linework. Clean the raster, then export ink as pixels or vectors.

## Open and use

**Double-click `index.html`** to open it in your browser. Internet access is required to download the processing engines; your images and exports stay on your machine.

1. Open a PNG of dark linework on a light background.
2. Adjust the **magick** controls while comparing the source and cleaned raster.
3. Adjust the **potrace** controls to refine the vector trace.
4. Export PNG, SVG, PDF, or DXF. Set **DPI** to control physical output size.

## Raster view (magick)

Cleanup preserves grayscale edges instead of turning the raster into a hard black-and-white mask.

| Stage / control | What it does |
|---|---|
| `-blur` | Estimates the paper background to correct uneven lighting. Set to 0 to skip. |
| `-resize` | Upsamples before cleanup levels to create softer transitions. |
| `-level` black / white | Darkens ink and clears paper while keeping intermediate shades. |
| `-connected-components 8` | Removes small isolated specks with a JavaScript component filter, preserving soft edges around retained ink. |
| Trim / `-border` | Crops empty margins and adds the selected border. |
| `-density` | Sets PNG DPI metadata and physical size for vector exports. |
| `-background` | Exports transparent black ink or opaque white paper. |

The speck filter uses JavaScript rather than ImageMagick's native component labeling because the Q8 WASM build cannot reliably label large numbers of regions. An all-white cleanup is reported as empty.

## Vector view (potrace)

The tracer uses the full-resolution cleaned raster. Thresholding changes the vector mask without changing your raster export.

| Control | What it does |
|---|---|
| Otsu / `threshold` | Chooses the ink cutoff automatically, or lets you set it manually. |
| `threshold offset` | Shifts the cutoff; positive values include paler ink. |
| `-connected-components 8` / `--turdsize` | Removes small blobs before tracing and suppresses small traced paths. |
| `--alphamax` | Controls corner smoothing; 0 produces polygons. |
| `--opttolerance` | Controls curve simplification; 0 disables it. |
| `--color` | Sets the vector fill color. |

## Preview and export

Edits update both previews automatically. Click a preview to expand it. White/red preview backdrops help inspect edges and do not change exported files. **Reset to defaults** restores the controls and backgrounds.

| Format | Output |
|---|---|
| PNG | Cleaned 8-bit grayscale or black ink with soft transparency; retains the selected DPI. |
| SVG | Filled vector paths with transparent holes, tight bounds, and dimensions in millimetres. |
| PDF | A tightly sized vector page; transparent or white background follows the raster background setting. |
| DXF | Filled linework for CAD workflows, using solid hatches with holes and millimetre units. Curves are approximated with short segments. |

Vector exports crop to the ink, excluding the raster border. DPI changes vector physical size without changing the paths. Check the displayed dimensions in your destination application. Exports use Save As where supported, otherwise your browser's download flow.

The **aliasing guard** reports intermediate tones around raster edges. A draft reading is not full-resolution export validation; fewer than 100 edge samples means insufficient evidence. Outputs above 25 megapixels are rejected—reduce the resize factor if needed.

## Privacy and dependencies

Images are processed locally in browser workers. There are no uploads, analytics, or external fonts. The engines load from jsDelivr:

- **ImageMagick WASM 0.0.43:** [Apache-2.0 wrapper license](https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.43/LICENSE), [source](https://github.com/dlemstra/magick-wasm), and [ImageMagick license](https://imagemagick.org/script/license.php).
- **ESM Potrace WASM 0.5.1:** [GPL-2.0-or-later source grant](https://github.com/tomayac/esm-potrace-wasm/blob/6e09291c5808435830a8d1c519057fd6bfcc2050/src/potrace.js), [source and build scripts](https://github.com/tomayac/esm-potrace-wasm/tree/6e09291c5808435830a8d1c519057fd6bfcc2050), and [license text](https://cdn.jsdelivr.net/npm/esm-potrace-wasm@0.5.1/LICENSE). Its package metadata uses the older `GPL-2.0` label. Original [Potrace](https://potrace.sourceforge.net/) also permits GPL version 2 or later.

## Development

The app is one HTML file with no build step. Run the dependency-free Node tests with `npm test`.

Optional checks against the pinned PNG encoder:

```sh
npm install --no-save --package-lock=false @imagemagick/magick-wasm@0.0.43
node tests.mjs --wasm
```

Tests generate synthetic inputs. Optional independent export checks run when Python XML parsing, `pdfinfo`, and `ezdxf` are available. PDF input, batch processing, color raster cleanup, and offline engine packaging are outside the current scope.

## License

Ink Cleanup is free software: you may redistribute and modify it under the GNU General Public License, version 2 or, at your option, any later version (**GPL-2.0-or-later**). See [LICENSE](LICENSE). It is provided without warranty.

The engines retain their own licenses. For distribution as a combined program with the Apache-2.0 engine, use the GPLv3 option permitted by this license; Apache-2.0 is not compatible with GPLv2-only. See [Apache's compatibility guidance](https://www.apache.org/licenses/GPL-compatibility.html).

Commercial use is allowed. Ordinary exported artwork does not inherit the software license; you remain responsible for permission to use your input images.
