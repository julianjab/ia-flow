import AppKit

// Glifo de la barra de menú: un pipeline de tres nodos (refine → build → review) unidos por un conector
// en S. Reposo: nodos huecos; algo corriendo: nodos llenos. Template: macOS lo tiñe según el tema.
func flowIcon(running: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        let nodes = [NSPoint(x: 3, y: 3), NSPoint(x: 9, y: 9), NSPoint(x: 15, y: 15)]
        let radius: CGFloat = 2.5
        let line: CGFloat = 1.3
        let circles = nodes.map { NSBezierPath(ovalIn: NSRect(x: $0.x - radius, y: $0.y - radius, width: radius * 2, height: radius * 2)) }

        let link = NSBezierPath()
        link.move(to: nodes[0])
        link.curve(to: nodes[1], controlPoint1: NSPoint(x: 8, y: 3), controlPoint2: NSPoint(x: 9, y: 4.5))
        link.curve(to: nodes[2], controlPoint1: NSPoint(x: 9, y: 13.5), controlPoint2: NSPoint(x: 10, y: 15))
        link.lineWidth = line
        link.lineCapStyle = .round

        NSColor.black.set()
        NSGraphicsContext.saveGraphicsState()
        // El conector no entra en los nodos: se recorta un poco dentro de cada aro para que no quede costura.
        let clip = NSBezierPath(rect: NSRect(x: 0, y: 0, width: 18, height: 18))
        circles.forEach { clip.append(NSBezierPath(ovalIn: $0.bounds.insetBy(dx: line / 2, dy: line / 2))) }
        clip.windingRule = .evenOdd
        clip.addClip()
        link.stroke()
        NSGraphicsContext.restoreGraphicsState()

        for circle in circles {
            if running {
                circle.fill()
            } else {
                let ring = NSBezierPath(ovalIn: circle.bounds.insetBy(dx: line / 2, dy: line / 2))
                ring.lineWidth = line
                ring.stroke()
            }
        }
        return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "ia-flow"
    return image
}
