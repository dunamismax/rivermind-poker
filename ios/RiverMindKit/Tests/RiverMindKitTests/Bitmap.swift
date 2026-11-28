import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import Testing
import UniformTypeIdentifiers

/// An image as premultiplied sRGB RGBA bytes, for comparing drawings pixel by pixel
/// (P5D.5's art parity and snapshot tests).
struct Bitmap {
    let width: Int
    let height: Int
    var bytes: [UInt8]

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        bytes = Array(repeating: 0, count: width * height * 4)
    }

    /// `image`, or the part of it in `crop` (in its pixels), redrawn as sRGB.
    init(_ image: CGImage, crop: CGRect? = nil) {
        let source = crop.flatMap { image.cropping(to: $0) } ?? image
        self.init(width: source.width, height: source.height)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    static func read(_ url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    var image: CGImage {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }

    func write(_ url: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { throw CocoaError(.fileWriteUnknown) }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    }

    /// How two drawings of the same size differ: the mean difference of a channel, 0 to
    /// 255, and the share of pixels where some channel differs by more than `far`.
    struct Difference: CustomStringConvertible {
        let mean: Double
        let farShare: Double

        var description: String {
            String(format: "mean %.2f, %.2f%% of pixels far apart", mean, farShare * 100)
        }
    }

    func difference(from other: Bitmap, far: Int = 64) -> Difference {
        precondition(width == other.width && height == other.height, "sizes differ")
        var total = 0
        var farPixels = 0
        for pixel in 0..<(width * height) {
            var worst = 0
            for channel in 0..<4 {
                let d = abs(Int(bytes[pixel * 4 + channel]) - Int(other.bytes[pixel * 4 + channel]))
                total += d
                worst = max(worst, d)
            }
            if worst > far { farPixels += 1 }
        }
        return Difference(
            mean: Double(total) / Double(width * height * 4), farShare: Double(farPixels) / Double(width * height))
    }

    /// Whether anything at all is drawn.
    var isBlank: Bool { !bytes.enumerated().contains { $0.offset % 4 == 3 && $0.element != 0 } }
}

/// The tests that draw (P5D.5), run one at a time: each holds the main actor while it draws,
/// and the table connection's tests, which wait on the main actor for at most two seconds,
/// must still get their turns between drawings.
@Suite(.serialized)
@MainActor
enum LookRendering {}

/// A SwiftUI view drawn at `scale` pixels a point, as SwiftUI draws it on a screen.
@MainActor
func render(_ view: some View, width: Double, height: Double, scale: Double) -> Bitmap? {
    let renderer = ImageRenderer(content: view.frame(width: width, height: height))
    renderer.scale = scale
    renderer.isOpaque = false
    return renderer.cgImage.map { Bitmap($0) }
}
