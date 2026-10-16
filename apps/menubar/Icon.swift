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

/// Identificador de la app sobre el tile de la marca: una pastilla lima abajo a la derecha con unas letras
/// (`IA` acá, `MP` en MacPulse). Distingue apps que comparten el tile de jabsolutions en la barra.
private let tagText = NSAttributedString(string: "IA", attributes: [
    .font: NSFont.systemFont(ofSize: 6.5, weight: .black), .foregroundColor: Brand.ink, .kern: -0.2,
])
/// La pastilla arranca donde termina el último chevron (x ≈ 14.8: 441/512 del tile de 16 corrido 1): pisa
/// sólo el borde del tile, no las etapas.
private let tagX: CGFloat = 15
private let tagWidth = tagText.size().width + 3

private func drawTag() {
    let text = tagText
    let size = text.size()
    let pill = NSRect(x: tagX, y: 0, width: tagWidth, height: 8)
    // un aro del color de la barra separa la pastilla del tile
    NSColor.windowBackgroundColor.setFill()
    NSBezierPath(roundedRect: pill.insetBy(dx: -1, dy: -1), xRadius: 3, yRadius: 3).fill()
    Brand.lime.setFill()
    NSBezierPath(roundedRect: pill, xRadius: 2.5, yRadius: 2.5).fill()
    text.draw(at: NSPoint(x: pill.midX - size.width / 2, y: pill.midY - size.height / 2))
}

/// El ícono de la barra de menú: el tile a 16 pt con la pastilla `IA` abajo a la derecha. Con `badge` > 0, un
/// círculo rojo arriba a la derecha con cuántas tareas te esperan en el runner elegido (más de 9 → «9+»).
func menuBarIcon(running: Bool, badge: Int = 0) -> NSImage {
    let inner = appIcon(size: 16, running: running)
    let label = badge > 9 ? "9+" : "\(badge)"
    let font = NSFont.systemFont(ofSize: 8, weight: .heavy)
    let text = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor.white])
    let badgeWidth = badge > 0 ? max(10, text.size().width + 4) : 0
    let width = max(tagX + tagWidth + 1, 18 + max(0, badgeWidth - 4))
    let image = NSImage(size: NSSize(width: width, height: 18), flipped: false) { rect in
        inner.draw(in: NSRect(x: 1, y: 1, width: 16, height: 16))
        drawTag()
        guard badge > 0 else { return true }
        let pill = NSRect(x: rect.maxX - badgeWidth, y: rect.maxY - 10, width: badgeWidth, height: 10)
        // un aro del color de la barra separa el badge del tile
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(roundedRect: pill.insetBy(dx: -1, dy: -1), xRadius: 6, yRadius: 6).fill()
        NSColor.systemRed.setFill()
        NSBezierPath(roundedRect: pill, xRadius: 5, yRadius: 5).fill()
        let size = text.size()
        text.draw(at: NSPoint(x: pill.midX - size.width / 2, y: pill.midY - size.height / 2))
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
