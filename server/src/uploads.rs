use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};

use crate::util::{sanitize_filename, sha256_hex};

pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_MOD_FILE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Copy)]
pub enum ImageKind {
    Thumbnail,
    Screenshot,
}

pub struct ProcessedImage {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
}

pub fn process_image(data: &[u8], kind: ImageKind) -> Result<ProcessedImage, String> {
    if data.len() > MAX_IMAGE_BYTES {
        return Err("images can be up to 8 MB".into());
    }
    let mut reader = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .map_err(|_| "couldn't read this image".to_string())?;
    match reader.format() {
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) => {}
        _ => return Err("only png, jpg, webp and gif images are allowed".into()),
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(10_000);
    limits.max_image_height = Some(10_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "this image is broken or too large".to_string())?;

    let (max_w, max_h) = match kind {
        ImageKind::Thumbnail => (960, 540),
        ImageKind::Screenshot => (1920, 1080),
    };
    let image = if image.width() > max_w || image.height() > max_h {
        image.resize(max_w, max_h, FilterType::Lanczos3)
    } else {
        image
    };

    let mut bytes = Vec::new();
    if image.color().has_alpha() {
        DynamicImage::ImageRgba8(image.to_rgba8())
            .write_with_encoder(PngEncoder::new(&mut bytes))
            .map_err(|_| "couldn't save this image".to_string())?;
        Ok(ProcessedImage { bytes, ext: "png" })
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
            .write_with_encoder(JpegEncoder::new_with_quality(&mut bytes, 82))
            .map_err(|_| "couldn't save this image".to_string())?;
        Ok(ProcessedImage { bytes, ext: "jpg" })
    }
}

pub struct CheckedFile {
    pub name: String,
    pub sha256: String,
    pub size: i64,
    pub kind: &'static str,
}

pub fn check_mod_file(original_name: &str, data: &[u8]) -> Result<CheckedFile, String> {
    if data.is_empty() {
        return Err("the file is empty".into());
    }
    if data.len() > MAX_MOD_FILE_BYTES {
        return Err("mod files can be up to 50 MB".into());
    }
    let name = sanitize_filename(original_name).ok_or_else(|| "this file name can't be used. rename it and try again".to_string())?;
    let lower = name.to_ascii_lowercase();
    let kind = if lower.ends_with(".dll") {
        if !data.starts_with(b"MZ") {
            return Err("this .dll doesn't look like a real windows dll".into());
        }
        "dll"
    } else if lower.ends_with(".zip") {
        if !(data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06")) {
            return Err("this .zip doesn't look like a real zip file".into());
        }
        "zip"
    } else {
        return Err("only .dll and .zip files can be hosted".into());
    };
    Ok(CheckedFile { name, sha256: sha256_hex(data), size: data.len() as i64, kind })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_files_must_match_their_type() {
        assert!(check_mod_file("mod.dll", b"MZ\x90\x00").is_ok());
        assert!(check_mod_file("mod.dll", b"#!/bin/sh").is_err());
        assert!(check_mod_file("mod.zip", b"PK\x03\x04rest").is_ok());
        assert!(check_mod_file("mod.exe", b"MZ\x90\x00").is_err());
        assert!(check_mod_file("mod.dll", b"").is_err());
        let checked = check_mod_file("../../My Mod.dll", b"MZabc").unwrap();
        assert_eq!(checked.name, "My-Mod.dll");
        assert_eq!(checked.size, 5);
    }

    #[test]
    fn images_get_resized_and_reencoded() {
        let big = DynamicImage::new_rgb8(2000, 1000);
        let mut png = Cursor::new(Vec::new());
        big.write_to(&mut png, ImageFormat::Png).unwrap();
        let out = process_image(png.get_ref(), ImageKind::Thumbnail).unwrap();
        assert_eq!(out.ext, "jpg");
        let decoded = image::load_from_memory(&out.bytes).unwrap();
        assert!(decoded.width() <= 960 && decoded.height() <= 540);
    }

    #[test]
    fn non_images_are_rejected() {
        assert!(process_image(b"definitely not an image", ImageKind::Screenshot).is_err());
    }
}
