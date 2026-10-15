#!/usr/bin/env python3
import sys, os, struct, re

def parse_po(po_path):
    entries = {}
    with open(po_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Simple regex parser for msgid / msgstr
    pattern = re.compile(r'msgid\s+(".*?"(?:\s+".*?")*)\s+msgstr\s+(".*?"(?:\s+".*?")*)', re.DOTALL)
    for m in pattern.finditer(content):
        raw_id = m.group(1)
        raw_str = m.group(2)
        
        # parse string concatenation and unescape
        k = ''.join(eval(line.strip()) for line in raw_id.splitlines() if line.strip())
        v = ''.join(eval(line.strip()) for line in raw_str.splitlines() if line.strip())
        entries[k] = v
        
    return entries

def generate_mo(entries, outfile):
    keys = sorted(entries.keys())
    num_strings = len(keys)
    orig_table_offset = 28
    trans_table_offset = 28 + num_strings * 8
    
    strings_data = bytearray()
    orig_indices = []
    trans_indices = []
    
    cur_offset = trans_table_offset + num_strings * 8
    
    for k in keys:
        k_bytes = k.encode('utf-8') + b'\x00'
        orig_indices.append((len(k_bytes) - 1, cur_offset + len(strings_data)))
        strings_data.extend(k_bytes)
        
    for k in keys:
        v_bytes = entries[k].encode('utf-8') + b'\x00'
        trans_indices.append((len(v_bytes) - 1, cur_offset + len(strings_data)))
        strings_data.extend(v_bytes)
        
    header = struct.pack(
        '<Iiiiiii',
        0x950412de,
        0,
        num_strings,
        orig_table_offset,
        trans_table_offset,
        0,
        0
    )
    
    orig_table = bytearray()
    for l, o in orig_indices:
        orig_table.extend(struct.pack('<ii', l, o))
        
    trans_table = bytearray()
    for l, o in trans_indices:
        trans_table.extend(struct.pack('<ii', l, o))
        
    os.makedirs(os.path.dirname(outfile), exist_ok=True)
    with open(outfile, 'wb') as f:
        f.write(header + orig_table + trans_table + strings_data)
    print(f"[OK] Compiled {len(entries)} strings to {outfile}")

if __name__ == '__main__':
    po_file = sys.argv[1] if len(sys.argv) > 1 else 'po/es.po'
    mo_file = sys.argv[2] if len(sys.argv) > 2 else 'locale/es/LC_MESSAGES/knobflow.mo'
    entries = parse_po(po_file)
    generate_mo(entries, mo_file)
