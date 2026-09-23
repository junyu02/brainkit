// 00-系统/scripts/brain-clip-helper.swift
// Reads clipboard image and writes it to a specified path as PNG.
// Exit protocol:
//   exit 0 + stdout "OK:{bytes}:{changeCount}"     -> image saved
//   exit 0 + stdout "HTML:{bytes}:{changeCount}"   -> HTML rich content saved
//   exit 2 + stdout "NO_IMAGE:{changeCount}"        -> no image in clipboard
//   exit 1 + stderr "ERROR:{reason}:{changeCount}"  -> failure

import AppKit
import Foundation

let args = CommandLine.arguments
let outputPath = args.count > 1 ? args[1] : "/tmp/clipboard-out.png"

let pb = NSPasteboard.general
let changeCount = pb.changeCount

if let image = NSImage(pasteboard: pb) {
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fputs("ERROR:no_cgimage:\(changeCount)\n", stderr)
        exit(1)
    }
    let rep = NSBitmapImageRep(cgImage: cgImage)
    guard let pngData = rep.representation(using: .png, properties: [:]) else {
        fputs("ERROR:no_png_data:\(changeCount)\n", stderr)
        exit(1)
    }
    do {
        try pngData.write(to: URL(fileURLWithPath: outputPath))
        print("OK:\(pngData.count):\(changeCount)")
        exit(0)
    } catch {
        fputs("ERROR:write_failed:\(changeCount):\(error)\n", stderr)
        exit(1)
    }
}

// 2. Try HTML (rich text / web content)
if let htmlData = pb.data(forType: NSPasteboard.PasteboardType("public.html")) {
    do {
        try htmlData.write(to: URL(fileURLWithPath: outputPath))
        print("HTML:\(htmlData.count):\(changeCount)")
        exit(0)
    } catch {
        fputs("ERROR:html_write_failed:\(changeCount):\(error)\n", stderr)
        exit(1)
    }
}

// 3. No image or HTML
print("NO_IMAGE:\(changeCount)")
exit(2)
