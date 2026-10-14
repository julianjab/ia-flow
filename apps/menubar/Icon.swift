import AppKit

// Marca jabsolutions: la J con el chevron encajado en la muesca de su gancho. La geometría es la del sistema de
// marca (grilla de 300 u, y hacia abajo; la J ocupa x de 58 a 276). Lima #C6FF3D sobre casi negro #0B0B0F.
// Ícono de app de la marca: tile de 512 px con radio 112 y la J a escala 1,2 centrada.

enum Brand {
    static let lime = NSColor(srgbRed: 0xC6 / 255, green: 0xFF / 255, blue: 0x3D / 255, alpha: 1)
    static let ink = NSColor(srgbRed: 0x0B / 255, green: 0x0B / 255, blue: 0x0F / 255, alpha: 1)
    static let bone = NSColor(srgbRed: 0xF4 / 255, green: 0xF5 / 255, blue: 0xF0 / 255, alpha: 1)
}

/// La J completa (chevron + letra) en las coordenadas de la marca. Las curvas son Bézier explícitas: los arcos
/// del SVG son cuartos de círculo (kappa 0,5523) y así no dependen del sentido de los ángulos al voltear el eje.
private func brandMark() -> NSBezierPath {
    let k: CGFloat = 0.5523
    let path = NSBezierPath()

    // chevron: encaja en la muesca del gancho
    path.move(to: NSPoint(x: 58, y: 220))
    for p in [(102, 220), (142, 260), (102, 300), (58, 300), (98, 260)] { path.line(to: NSPoint(x: p.0, y: p.1)) }
    path.close()

    // J (el path original está desplazado 76 en x)
    func quad(_ from: NSPoint, control c: NSPoint, to: NSPoint) {
        path.curve(to: to,
                   controlPoint1: NSPoint(x: from.x + 2 / 3 * (c.x - from.x), y: from.y + 2 / 3 * (c.y - from.y)),
                   controlPoint2: NSPoint(x: to.x + 2 / 3 * (c.x - to.x), y: to.y + 2 / 3 * (c.y - to.y)))
    }
    path.move(to: NSPoint(x: 129, y: 0))
    path.line(to: NSPoint(x: 268, y: 0))
    quad(NSPoint(x: 268, y: 0), control: NSPoint(x: 276, y: 0), to: NSPoint(x: 276, y: 8))
    path.line(to: NSPoint(x: 276, y: 210))
    // arco exterior del gancho: centro (186, 210), radio 90, de (276, 210) a (186, 300)
    path.curve(to: NSPoint(x: 186, y: 300), controlPoint1: NSPoint(x: 276, y: 210 + 90 * k), controlPoint2: NSPoint(x: 186 + 90 * k, y: 300))
    path.line(to: NSPoint(x: 116, y: 300))
    path.line(to: NSPoint(x: 156, y: 260))
    path.line(to: NSPoint(x: 116, y: 220))
    path.line(to: NSPoint(x: 186, y: 220))
    // arco interior: centro (186, 210), radio 10, de (186, 220) a (196, 210)
    path.curve(to: NSPoint(x: 196, y: 210), controlPoint1: NSPoint(x: 186 + 10 * k, y: 220), controlPoint2: NSPoint(x: 196, y: 210 + 10 * k))
    path.line(to: NSPoint(x: 196, y: 70))
    path.line(to: NSPoint(x: 129, y: 70))
    quad(NSPoint(x: 129, y: 70), control: NSPoint(x: 121, y: 70), to: NSPoint(x: 121, y: 62))
    path.line(to: NSPoint(x: 121, y: 8))
    quad(NSPoint(x: 121, y: 8), control: NSPoint(x: 121, y: 0), to: NSPoint(x: 129, y: 0))
    path.close()
    return path
}

/// El ícono de app de la marca a `size` pt: tile oscuro con la J. `running` la pinta en lima; en reposo, atenuada.
/// No es template: el lima es parte de la marca y se lee igual en la barra de menú clara y oscura.
func brandIcon(size: CGFloat, running: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
        let f = rect.width / 512
        let tile = NSBezierPath(roundedRect: rect, xRadius: 112 * f, yRadius: 112 * f)
        Brand.ink.setFill()
        tile.fill()

        let mark = brandMark()
        // translate(55.6 76) scale(1.2) del SVG de la marca: primero la escala y después el desplazamiento
        let t = NSAffineTransform()
        t.translateX(by: 55.6 * f, yBy: 76 * f)
        t.scaleX(by: 1.2 * f, yBy: 1.2 * f)
        mark.transform(using: t as AffineTransform)
        (running ? Brand.lime : Brand.bone.withAlphaComponent(0.5)).setFill()
        mark.fill()
        return true
    }
    image.accessibilityDescription = "ia-flow"
    return image
}

/// El ícono de la barra de menú: el tile a 16 pt dentro del lienzo de 18 pt de la barra.
func menuBarIcon(running: Bool) -> NSImage {
    let inner = brandIcon(size: 16, running: running)
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        inner.draw(in: NSRect(x: 1, y: 1, width: 16, height: 16))
        return true
    }
    image.accessibilityDescription = "ia-flow"
    return image
}

/// PNG del ícono de app a `pixels` px (para generar el .icns en build.sh).
func brandPNG(pixels: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    brandIcon(size: CGFloat(pixels), running: true).draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}
