import { join } from "node:path";
import { nativeImage } from "electron";
import type { AppRelease } from "./repository";

const iconColors = [
  [84, 2, 198],   // Violet
  [42, 87, 196],  // Cobalt
  [0, 129, 132],  // Teal
  [52, 126, 71],  // Fern
  [185, 122, 18], // Amber
  [214, 82, 38],  // Persimmon
  [188, 48, 100], // Raspberry
  [65, 88, 117],  // Slate
];

export type AppInstance = AppRelease & {
  projectDirectory: string;
  repositoryDirectory?: string;
};

function iconChunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(data.length + header.length, 4);
  return Buffer.concat([header, data]);
}

export function projectIcon(color: number) {
  let icon = nativeImage.createFromPath(join(__dirname, "../branding/generated-app-icon.png"));
  if (icon.isEmpty()) throw new Error("The generated app icon is missing.");

  if (color !== 0) {
    const pixels = icon.toBitmap();
    const [red, green, blue] = iconColors[color];
    const [paperRed, paperGreen, paperBlue] = [251, 244, 235];
    // The green channel falls from cream to violet across both the mark and its glow.
    // This coverage includes alpha because NativeImage stores premultiplied BGRA.
    const greenRange = paperGreen - iconColors[0][1];
    for (let i = 0; i < pixels.length; i += 4) {
      const opacity = pixels[i + 3] / 255;
      const coverage = Math.max(0, Math.min(opacity, (paperGreen * opacity - pixels[i + 1]) / greenRange));
      pixels[i] = Math.round(paperBlue * opacity + (blue - paperBlue) * coverage);
      pixels[i + 1] = Math.round(paperGreen * opacity + (green - paperGreen) * coverage);
      pixels[i + 2] = Math.round(paperRed * opacity + (red - paperRed) * coverage);
    }
    icon = nativeImage.createFromBitmap(pixels, icon.getSize());
  }

  return icon;
}

export function makeIcon(color: number) {
  const icon = projectIcon(color);
  const sizes: [string, number][] = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128],
    ["ic08", 256], ["ic09", 512], ["ic10", 1024],
    ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
  ];
  const pngs = new Map<number, Buffer>();
  const chunks = sizes.map(([type, size]) => {
    let png = pngs.get(size);
    if (!png) {
      png = icon.resize({ width: size, height: size, quality: "best" }).toPNG();
      pngs.set(size, png);
    }
    return iconChunk(type, png);
  });
  return iconChunk("icns", Buffer.concat(chunks));
}
