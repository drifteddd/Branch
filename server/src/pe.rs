#[derive(Default, Debug, Clone)]
pub struct PeInfo {
    pub is_dotnet: bool,
    pub native_imports: Vec<String>,
    pub assembly_name: Option<String>,
    pub assembly_refs: Vec<String>,
    pub api_calls: Vec<String>,
    pub pinvokes: Vec<String>,
    pub defined_types: Vec<String>,
    pub defined_methods: Vec<String>,
    pub type_count: usize,
    pub method_count: usize,
    pub obfuscated_names: bool,
}

fn u16_at(d: &[u8], o: usize) -> Option<u16> {
    d.get(o..o.checked_add(2)?).map(|b| u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o.checked_add(4)?).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn u64_at(d: &[u8], o: usize) -> Option<u64> {
    d.get(o..o.checked_add(8)?).map(|b| u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
}

fn cstr(d: &[u8], o: usize) -> Option<String> {
    let rest = d.get(o..)?;
    let end = rest.iter().take(512).position(|&b| b == 0)?;
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

struct Section {
    va: u32,
    vsize: u32,
    raw_ptr: u32,
    raw_size: u32,
}

fn rva_to_offset(sections: &[Section], rva: u32) -> Option<usize> {
    for s in sections {
        let size = s.vsize.max(s.raw_size);
        if rva >= s.va && rva < s.va.saturating_add(size) {
            let off = rva - s.va;
            if off < s.raw_size {
                return Some(s.raw_ptr as usize + off as usize);
            }
        }
    }
    None
}

pub fn inspect(d: &[u8]) -> Option<PeInfo> {
    if !d.starts_with(b"MZ") {
        return None;
    }
    let pe = u32_at(d, 0x3c)? as usize;
    if d.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let coff = pe + 4;
    let section_count = u16_at(d, coff + 2)? as usize;
    let optional_size = u16_at(d, coff + 16)? as usize;
    let optional = coff + 20;
    let (dirs, is_64) = match u16_at(d, optional)? {
        0x10b => (optional + 96, false),
        0x20b => (optional + 112, true),
        _ => return None,
    };
    let dir_count = u32_at(d, dirs - 4)? as usize;
    let dir = |i: usize| -> Option<(u32, u32)> {
        if i >= dir_count {
            return None;
        }
        Some((u32_at(d, dirs + i * 8)?, u32_at(d, dirs + i * 8 + 4)?))
    };

    let table = optional + optional_size;
    let mut sections = Vec::new();
    for i in 0..section_count.min(96) {
        let s = table + i * 40;
        sections.push(Section { vsize: u32_at(d, s + 8)?, va: u32_at(d, s + 12)?, raw_size: u32_at(d, s + 16)?, raw_ptr: u32_at(d, s + 20)? });
    }

    let mut info = PeInfo::default();
    if let Some((rva, size)) = dir(1) {
        if rva != 0 && size != 0 {
            info.native_imports = read_imports(d, &sections, rva, is_64);
        }
    }
    if let Some((rva, _)) = dir(14) {
        if rva != 0 {
            if let Some(cli) = rva_to_offset(&sections, rva) {
                info.is_dotnet = true;
                if let Some(md) = u32_at(d, cli + 8).and_then(|r| rva_to_offset(&sections, r)) {
                    let _ = read_metadata(d, md, &mut info);
                }
            }
        }
    }
    Some(info)
}

fn read_imports(d: &[u8], sections: &[Section], rva: u32, is_64: bool) -> Vec<String> {
    let mut out = Vec::new();
    let Some(mut desc) = rva_to_offset(sections, rva) else { return out };
    for _ in 0..256 {
        let (Some(original), Some(name_rva), Some(first)) = (u32_at(d, desc), u32_at(d, desc + 12), u32_at(d, desc + 16)) else { break };
        if original == 0 && name_rva == 0 && first == 0 {
            break;
        }
        let dll = rva_to_offset(sections, name_rva).and_then(|o| cstr(d, o)).unwrap_or_default().to_lowercase();
        let thunks = if original != 0 { original } else { first };
        if let Some(mut t) = rva_to_offset(sections, thunks) {
            for _ in 0..4000 {
                let (value, by_ordinal) = if is_64 {
                    let Some(v) = u64_at(d, t) else { break };
                    (v & 0x7fff_ffff, v >> 63 == 1)
                } else {
                    let Some(v) = u32_at(d, t) else { break };
                    (u64::from(v) & 0x7fff_ffff, v >> 31 == 1)
                };
                if value == 0 && !by_ordinal {
                    break;
                }
                if !by_ordinal {
                    if let Some(name) = rva_to_offset(sections, value as u32).and_then(|o| cstr(d, o + 2)) {
                        out.push(format!("{dll}!{name}"));
                    }
                }
                if out.len() >= 800 {
                    return out;
                }
                t += if is_64 { 8 } else { 4 };
            }
        }
        desc += 20;
    }
    out
}

const MODULE: usize = 0x00;
const TYPE_REF: usize = 0x01;
const TYPE_DEF: usize = 0x02;
const FIELD: usize = 0x04;
const METHOD_DEF: usize = 0x06;
const PARAM: usize = 0x08;
const INTERFACE_IMPL: usize = 0x09;
const MEMBER_REF: usize = 0x0A;
const DECL_SECURITY: usize = 0x0E;
const STANDALONE_SIG: usize = 0x11;
const EVENT: usize = 0x14;
const PROPERTY: usize = 0x17;
const MODULE_REF: usize = 0x1A;
const TYPE_SPEC: usize = 0x1B;
const IMPL_MAP: usize = 0x1C;
const ASSEMBLY: usize = 0x20;
const ASSEMBLY_REF: usize = 0x23;
const FILE: usize = 0x26;
const EXPORTED_TYPE: usize = 0x27;
const MANIFEST_RESOURCE: usize = 0x28;
const GENERIC_PARAM: usize = 0x2A;
const METHOD_SPEC: usize = 0x2B;
const GENERIC_PARAM_CONSTRAINT: usize = 0x2C;

fn read_metadata(d: &[u8], md: usize, info: &mut PeInfo) -> Option<()> {
    if u32_at(d, md)? != 0x424A_5342 {
        return None;
    }
    let version_len = u32_at(d, md + 12)? as usize;
    let mut p = md + 16 + version_len;
    let stream_count = u16_at(d, p + 2)? as usize;
    p += 4;
    let mut tables = None;
    let mut strings = None;
    for _ in 0..stream_count.min(16) {
        let offset = u32_at(d, p)? as usize;
        let size = u32_at(d, p + 4)? as usize;
        let name_start = p + 8;
        let mut end = name_start;
        while *d.get(end)? != 0 {
            end += 1;
            if end - name_start > 32 {
                return None;
            }
        }
        let name = &d[name_start..end];
        let name_len = end + 1 - name_start;
        p = name_start + ((name_len + 3) & !3);
        match name {
            b"#~" | b"#-" => tables = Some(md + offset),
            b"#Strings" => strings = Some((md + offset, size)),
            _ => {}
        }
    }
    let t = tables?;
    let (strings_at, strings_size) = strings?;

    let heap_sizes = *d.get(t + 6)?;
    let str_size = if heap_sizes & 0x01 != 0 { 4 } else { 2 };
    let guid_size = if heap_sizes & 0x02 != 0 { 4 } else { 2 };
    let blob_size = if heap_sizes & 0x04 != 0 { 4 } else { 2 };
    let valid = u64_at(d, t + 8)?;
    let mut rows = [0u32; 64];
    let mut q = t + 24;
    for (i, row) in rows.iter_mut().enumerate() {
        if (valid >> i) & 1 == 1 {
            *row = u32_at(d, q)?;
            q += 4;
        }
    }
    if heap_sizes & 0x40 != 0 {
        q += 4;
    }

    let idx = |table: usize| if rows[table] < 0x1_0000 { 2 } else { 4 };
    let coded = |bits: u32, list: &[usize]| {
        let max = list.iter().map(|&t| rows[t]).max().unwrap_or(0);
        if max < (1u32 << (16 - bits)) { 2 } else { 4 }
    };
    let type_def_or_ref = coded(2, &[TYPE_DEF, TYPE_REF, TYPE_SPEC]);
    let resolution_scope = coded(2, &[MODULE, MODULE_REF, ASSEMBLY_REF, TYPE_REF]);
    let member_ref_parent = coded(3, &[TYPE_DEF, TYPE_REF, MODULE_REF, METHOD_DEF, TYPE_SPEC]);
    let has_constant = coded(2, &[FIELD, PARAM, PROPERTY]);
    let has_custom_attribute = coded(
        5,
        &[
            METHOD_DEF, FIELD, TYPE_REF, TYPE_DEF, PARAM, INTERFACE_IMPL, MEMBER_REF, MODULE, DECL_SECURITY, PROPERTY, EVENT,
            STANDALONE_SIG, MODULE_REF, TYPE_SPEC, ASSEMBLY, ASSEMBLY_REF, FILE, EXPORTED_TYPE, MANIFEST_RESOURCE, GENERIC_PARAM,
            GENERIC_PARAM_CONSTRAINT, METHOD_SPEC,
        ],
    );
    let custom_attribute_type = coded(3, &[METHOD_DEF, MEMBER_REF]);
    let has_field_marshal = coded(1, &[FIELD, PARAM]);
    let has_decl_security = coded(2, &[TYPE_DEF, METHOD_DEF, ASSEMBLY]);
    let has_semantics = coded(1, &[EVENT, PROPERTY]);
    let method_def_or_ref = coded(1, &[METHOD_DEF, MEMBER_REF]);
    let member_forwarded = coded(1, &[FIELD, METHOD_DEF]);

    let row_size: [usize; 0x24] = [
        2 + str_size + 3 * guid_size,
        resolution_scope + 2 * str_size,
        4 + 2 * str_size + type_def_or_ref + idx(FIELD) + idx(METHOD_DEF),
        idx(FIELD),
        2 + str_size + blob_size,
        idx(METHOD_DEF),
        4 + 2 + 2 + str_size + blob_size + idx(PARAM),
        idx(PARAM),
        2 + 2 + str_size,
        idx(TYPE_DEF) + type_def_or_ref,
        member_ref_parent + str_size + blob_size,
        2 + has_constant + blob_size,
        has_custom_attribute + custom_attribute_type + blob_size,
        has_field_marshal + blob_size,
        2 + has_decl_security + blob_size,
        2 + 4 + idx(TYPE_DEF),
        4 + idx(FIELD),
        blob_size,
        idx(TYPE_DEF) + idx(EVENT),
        idx(EVENT),
        2 + str_size + type_def_or_ref,
        idx(TYPE_DEF) + idx(PROPERTY),
        idx(PROPERTY),
        2 + str_size + blob_size,
        2 + idx(METHOD_DEF) + has_semantics,
        idx(TYPE_DEF) + 2 * method_def_or_ref,
        str_size,
        blob_size,
        2 + member_forwarded + str_size + idx(MODULE_REF),
        4 + idx(FIELD),
        8,
        4,
        4 + 8 + 4 + blob_size + 2 * str_size,
        4,
        12,
        8 + 4 + blob_size + 2 * str_size + blob_size,
    ];
    let mut start = [0usize; 0x24];
    let mut cursor = q;
    for i in 0..0x24 {
        start[i] = cursor;
        cursor = cursor.saturating_add(row_size[i].saturating_mul(rows[i] as usize));
    }

    let read_index = |o: usize, size: usize| -> Option<u32> { if size == 2 { u16_at(d, o).map(u32::from) } else { u32_at(d, o) } };
    let string = |i: u32| -> String {
        if i as usize >= strings_size {
            return String::new();
        }
        cstr(d, strings_at + i as usize).unwrap_or_default()
    };
    let full_name = |ns: String, name: String| if ns.is_empty() { name } else { format!("{ns}.{name}") };

    let mut type_refs = Vec::new();
    for r in 0..(rows[TYPE_REF] as usize).min(50_000) {
        let o = start[TYPE_REF] + r * row_size[TYPE_REF];
        let name = string(read_index(o + resolution_scope, str_size)?);
        let ns = string(read_index(o + resolution_scope + str_size, str_size)?);
        type_refs.push(full_name(ns, name));
    }

    let mut module_refs = Vec::new();
    for r in 0..(rows[MODULE_REF] as usize).min(1000) {
        module_refs.push(string(read_index(start[MODULE_REF] + r * row_size[MODULE_REF], str_size)?));
    }

    let mut calls = std::collections::BTreeSet::new();
    for r in 0..(rows[MEMBER_REF] as usize).min(100_000) {
        let o = start[MEMBER_REF] + r * row_size[MEMBER_REF];
        let parent = read_index(o, member_ref_parent)?;
        let name = string(read_index(o + member_ref_parent, str_size)?);
        let (tag, row) = (parent & 0x7, (parent >> 3) as usize);
        let owner = match tag {
            1 => type_refs.get(row.wrapping_sub(1)).cloned(),
            2 => module_refs.get(row.wrapping_sub(1)).cloned(),
            _ => None,
        };
        if let Some(owner) = owner {
            calls.insert(format!("{owner}::{name}"));
        }
    }
    info.api_calls = calls.into_iter().collect();

    let mut weird = 0usize;
    let mut checked = 0usize;
    let mut is_weird = |name: &str| {
        checked += 1;
        let gibberish = name.chars().any(|c| !c.is_ascii() || c.is_control()) || (name.len() <= 2 && !name.is_empty());
        if gibberish {
            weird += 1;
        }
    };

    info.type_count = rows[TYPE_DEF] as usize;
    for r in 0..(rows[TYPE_DEF] as usize).min(20_000) {
        let o = start[TYPE_DEF] + r * row_size[TYPE_DEF];
        let name = string(read_index(o + 4, str_size)?);
        let ns = string(read_index(o + 4 + str_size, str_size)?);
        if name == "<Module>" || name.starts_with("<PrivateImplementationDetails>") {
            continue;
        }
        is_weird(&name);
        if info.defined_types.len() < 80 && !name.contains('<') {
            info.defined_types.push(full_name(ns, name));
        }
    }

    info.method_count = rows[METHOD_DEF] as usize;
    let mut methods = std::collections::BTreeSet::new();
    for r in 0..(rows[METHOD_DEF] as usize).min(50_000) {
        let o = start[METHOD_DEF] + r * row_size[METHOD_DEF];
        let name = string(read_index(o + 8, str_size)?);
        is_weird(&name);
        let boring = name.starts_with('.') || name.starts_with("get_") || name.starts_with("set_") || name.contains('<');
        if !boring && methods.len() < 120 {
            methods.insert(name);
        }
    }
    info.defined_methods = methods.into_iter().collect();
    info.obfuscated_names = checked >= 10 && weird * 100 / checked >= 30;

    for r in 0..(rows[IMPL_MAP] as usize).min(5000) {
        let o = start[IMPL_MAP] + r * row_size[IMPL_MAP];
        let import = string(read_index(o + 2 + member_forwarded, str_size)?);
        let scope = read_index(o + 2 + member_forwarded + str_size, idx(MODULE_REF))? as usize;
        let module = module_refs.get(scope.wrapping_sub(1)).cloned().unwrap_or_default();
        info.pinvokes.push(format!("{module}!{import}"));
    }

    if rows[ASSEMBLY] > 0 {
        let name = string(read_index(start[ASSEMBLY] + 4 + 8 + 4 + blob_size, str_size)?);
        if !name.is_empty() {
            info.assembly_name = Some(name);
        }
    }
    for r in 0..(rows[ASSEMBLY_REF] as usize).min(1000) {
        let o = start[ASSEMBLY_REF] + r * row_size[ASSEMBLY_REF];
        info.assembly_refs.push(string(read_index(o + 8 + 4 + blob_size, str_size)?));
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_is_rejected_quietly() {
        assert!(inspect(b"not a dll").is_none());
        assert!(inspect(b"MZ\x00\x00").is_none());
        let mut fake = vec![0u8; 512];
        fake[0] = b'M';
        fake[1] = b'Z';
        fake[0x3c] = 0x80;
        fake[0x80..0x84].copy_from_slice(b"PE\0\0");
        assert!(inspect(&fake).is_none());
    }

    #[test]
    fn reads_a_real_dotnet_dll_when_available() {
        let roots = ["/usr/share/dotnet/shared/Microsoft.NETCore.App", "/usr/lib/dotnet/shared/Microsoft.NETCore.App"];
        let Some(dir) = roots
            .iter()
            .filter_map(|r| std::fs::read_dir(r).ok())
            .flat_map(|entries| entries.filter_map(Result::ok))
            .map(|e| e.path())
            .find(|p| p.join("System.Net.Http.dll").exists())
        else {
            eprintln!("no .net runtime found, skipping");
            return;
        };
        let data = std::fs::read(dir.join("System.Net.Http.dll")).unwrap();
        let info = inspect(&data).expect("should parse");
        assert!(info.is_dotnet);
        assert_eq!(info.assembly_name.as_deref(), Some("System.Net.Http"));
        assert!(info.type_count > 10, "types: {}", info.type_count);
        assert!(info.api_calls.len() > 10, "calls: {}", info.api_calls.len());
        assert!(info.api_calls.iter().all(|c| c.contains("::")));
        assert!(info.assembly_refs.iter().any(|a| a.starts_with("System")), "{:?}", info.assembly_refs);
    }
}
