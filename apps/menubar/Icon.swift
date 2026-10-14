import AppKit

// Ícono de ia-flow: tres chevrones (refine › build › review) con la gramática de la marca jabsolutions —
// chevrón a 45°, tile de 512 px con radio 112, lima #C6FF3D sobre casi negro #0B0B0F. La última etapa va en
// lima; las dos anteriores, en hueso atenuado. Es el mismo dibujo que apps/web/public/favicon.svg.

enum Brand {
    static let lime = NSColor(srgbRed: 0xC6 / 255, green: 0xFF / 255, blue: 0x3D / 255, alpha: 1)
    static let ink = NSColor(srgbRed: 0x0B / 255, green: 0x0B / 255, blue: 0x0F / 255, alpha: 1)
    static let bone = NSColor(srgbRed: 0xF4 / 255, green: 0xF5 / 255, blue: 0xF0 / 255, alpha: 1)
}

/// Un chevrón en coordenadas del tile de 512 (y hacia abajo): borde izquierdo en `x`, de y 146 a 366,
/// trazo horizontal de 60 y brazos a 45°.
private func chevron(x a: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: a, y: 146))
    for p in [(a + 60, 146), (a + 170, 256), (a + 60, 366), (a, 366), (a + 110, 256)] as [(CGFloat, CGFloat)] {
        path.line(to: NSPoint(x: p.0, y: p.1))
    }
    path.close()
    return path
}

/// El ícono de app a `size` pt: tile oscuro con las tres etapas. `running` pinta la última en lima; en reposo
/// las tres quedan en hueso atenuado. No es template: el lima es de la marca y se lee en la barra clara y oscura.
func appIcon(size: CGFloat, running: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
        let f = rect.width / 512
        let tile = NSBezierPath(roundedRect: rect, xRadius: 112 * f, yRadius: 112 * f)
        Brand.ink.setFill()
        tile.fill()

        let scale = NSAffineTransform()
        scale.scaleX(by: f, yBy: f)
        let stages: [(CGFloat, NSColor)] = [
            (71, Brand.bone.withAlphaComponent(running ? 0.35 : 0.25)),
            (171, Brand.bone.withAlphaComponent(running ? 0.7 : 0.4)),
            (271, running ? Brand.lime : Brand.bone.withAlphaComponent(0.55)),
        ]
        for (x, color) in stages {
            let path = chevron(x: x)
            path.transform(using: scale as AffineTransform)
            color.setFill()
            path.fill()
        }
        return true
    }
    image.accessibilityDescription = "ia-flow"
    return image
}

/// El ícono de la barra de menú: el tile a 16 pt dentro del lienzo de 18 pt de la barra.
func menuBarIcon(running: Bool) -> NSImage {
    let inner = appIcon(size: 16, running: running)
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        inner.draw(in: NSRect(x: 1, y: 1, width: 16, height: 16))
        return true
    }
    image.accessibilityDescription = "ia-flow"
    return image
}

/// PNG del ícono de app a `pixels` px (para generar el .icns en build.sh).
func appIconPNG(pixels: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    appIcon(size: CGFloat(pixels), running: true).draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}
