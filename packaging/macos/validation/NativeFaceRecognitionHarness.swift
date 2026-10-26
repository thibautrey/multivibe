import AppKit
import Foundation

@main struct NativeFaceRecognitionChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        var first = Array(repeating: Float(0), count: 128); first[0] = 1
        var alternative = first; alternative[1] = 0.04
        var other = first; other[0] = -1
        var near = first; near[1] = 0.06
        precondition(NativeFaceDescriptorMatching.account(for: first, enrollments: ["a": [first, alternative], "b": [other]]) == "a")
        precondition(NativeFaceDescriptorMatching.account(for: other, enrollments: ["a": [first]]) == nil)
        precondition(NativeFaceDescriptorMatching.account(for: first, enrollments: ["a": [first], "b": [near]]) == nil)
        precondition(!NativeFaceDescriptorMatching.valid(Array(repeating: 0, count: 128)))
        precondition(!NativeFaceDescriptorMatching.valid([Float.nan]))
        precondition(NativeFaceDescriptorMatching.account(for: first, enrollments: ["bad": [[1]], "a": [first]]) == "a")
        var votes = NativeFaceIdentityVotes()
        precondition(votes.observe("a", at: 0) == nil)
        precondition(votes.observe("a", at: 0.1) == nil)
        precondition(votes.observe("a", at: 0.31) == nil)
        precondition(votes.observe(nil, at: 0.4) == nil)
        precondition(votes.observe("a", at: 0.71) == nil)
        precondition(votes.observe("a", at: 1.02) == nil)
        precondition(votes.observe("a", at: 1.33) == "a")
        precondition(votes.observe("b", at: 1.64) == nil)
        precondition(votes.observe("b", at: 3.7) == nil)

        guard CommandLine.arguments.count >= 2 else { fatalError("FaceRecognition resources argument is required") }
        let resources = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let engine = NativeFaceWebEngine(resources: resources)
        try await engine.prepare()
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 640, pixelsHigh: 480, bitsPerSample: 8,
            samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let pixels = bitmap.bitmapData else { fatalError("Unable to create blank image") }
        memset(pixels, 180, bitmap.bytesPerRow * bitmap.pixelsHigh)
        let jpeg = bitmap.representation(using: .jpeg, properties: [:])!
        let blank = try await engine.analyze(jpeg)
        precondition(blank.descriptor == nil && blank.faces == 0)

        // Optional portraits supplied explicitly by a developer; never read a camera or a user's photo library.
        // A: portrait, B: another image of A, C: a different person, D: a group image.
        if CommandLine.arguments.count >= 6 {
            var observations: [NativeFaceObservation] = []
            for filename in CommandLine.arguments[2...5] {
                observations.append(try await engine.analyze(Data(contentsOf: URL(fileURLWithPath: filename))))
            }
            guard let a = observations[0].descriptor, let b = observations[1].descriptor, let c = observations[2].descriptor else { fatalError("Portrait fixtures failed quality or descriptor extraction") }
            precondition(NativeFaceDescriptorMatching.distance(a, b) < NativeFaceDescriptorMatching.maximumDistance)
            precondition(NativeFaceDescriptorMatching.account(for: b, enrollments: ["a": [a], "c": [c]]) == "a")
            precondition(observations[3].faces > 1 && observations[3].descriptor == nil)
            print("PASS supplied portrait similarity and multi-face inference")
        }
        // Invalid image errors are bounded and never produce a descriptor.
        do { _ = try await engine.analyze(Data("not an image".utf8)); fatalError("Invalid image accepted") }
        catch NativeFaceRecognitionError.unavailable {}
        let cancelled = Task { try await engine.analyze(jpeg) }
        await Task.yield()
        engine.cancel()
        do { _ = try await cancelled.value; fatalError("Cancelled inference returned a sample") }
        catch {}
        print("PASS native face descriptors, ambiguity, temporal votes and real offline WebKit no-face inference; camera never accessed")
    }
}
