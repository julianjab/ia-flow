import AppKit

// Glifo de la barra de menú: una rama de git que sale de un commit y termina en un destello de IA.
// Reposo: commit y destello huecos; algo corriendo: llenos. Template: macOS lo tiñe según el tema.
func flowIcon(running: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        let line: CGFloat = 1.4
        let commit = NSPoint(x: 4, y: 3.5)
        let commitRadius: CGFloat = 2.4
        NSColor.black.set()

        let branch = NSBezierPath()
        branch.lineWidth = line
        branch.lineCapStyle = .round
        branch.move(to: NSPoint(x: 4, y: 5))
        branch.line(to: NSPoint(x: 4, y: 16.5))
        branch.move(to: NSPoint(x: 4, y: 7.5))
        branch.curve(to: NSPoint(x: 8.6, y: 12.5), controlPoint1: NSPoint(x: 4, y: 11), controlPoint2: NSPoint(x: 6, y: 12.5))
        branch.stroke()

        // El tronco no entra en el commit: se borra su interior antes de dibujar el aro.
        let ctx = NSGraphicsContext.current
        ctx?.compositingOperation = .destinationOut
        dot(commit, commitRadius).fill()
        ctx?.compositingOperation = .sourceOver
        if running {
            dot(commit, commitRadius).fill()
        } else {
            let ring = dot(commit, commitRadius - line / 2)
            ring.lineWidth = line
            ring.stroke()
        }

        let spark = sparkle(center: NSPoint(x: 13, y: 12.5), radius: 4.6, waist: 0.9)
        if running {
            spark.fill()
        } else {
            spark.lineWidth = 1.2
            spark.lineJoinStyle = .round
            spark.stroke()
        }
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "ia-flow"
    return image
}

private func dot(_ center: NSPoint, _ radius: CGFloat) -> NSBezierPath {
    NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
}

// Estrella de cuatro puntas de lados cóncavos; `waist` es cuánto se abre hacia el centro.
private func sparkle(center c: NSPoint, radius r: CGFloat, waist k: CGFloat) -> NSBezierPath {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: c.x, y: c.y + r))
    p.curve(to: NSPoint(x: c.x + r, y: c.y), controlPoint1: NSPoint(x: c.x + k * 0.2, y: c.y + k), controlPoint2: NSPoint(x: c.x + k, y: c.y + k * 0.2))
    p.curve(to: NSPoint(x: c.x, y: c.y - r), controlPoint1: NSPoint(x: c.x + k, y: c.y - k * 0.2), controlPoint2: NSPoint(x: c.x + k * 0.2, y: c.y - k))
    p.curve(to: NSPoint(x: c.x - r, y: c.y), controlPoint1: NSPoint(x: c.x - k * 0.2, y: c.y - k), controlPoint2: NSPoint(x: c.x - k, y: c.y - k * 0.2))
    p.curve(to: NSPoint(x: c.x, y: c.y + r), controlPoint1: NSPoint(x: c.x - k, y: c.y + k * 0.2), controlPoint2: NSPoint(x: c.x - k * 0.2, y: c.y + k))
    p.close()
    return p
}
