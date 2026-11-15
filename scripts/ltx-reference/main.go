// Generate independent golden files with upstream ltx/lz4 and Go CRC64.
package main

import (
	"bytes"
	"encoding/binary"
	"hash/crc64"
	"os"
	"path/filepath"

	"github.com/pierrec/lz4/v4"
	"github.com/superfly/ltx"
)

func check(err error) {
	if err != nil {
		panic(err)
	}
}
func read(dir, name string) []byte {
	b, err := os.ReadFile(filepath.Join(dir, name))
	check(err)
	return b
}
func sum(data []byte) ltx.Checksum {
	n, err := ltx.ChecksumReader(bytes.NewReader(data), 4096)
	check(err)
	return n
}

func encode(dir, name string, base, data []byte, min, max uint64) {
	file, err := os.Create(filepath.Join(dir, name))
	check(err)
	defer file.Close()
	encoder, err := ltx.NewEncoder(file)
	check(err)
	pre := ltx.Checksum(0)
	if min != 1 {
		pre = sum(base)
	}
	check(encoder.EncodeHeader(ltx.Header{Version: ltx.Version, PageSize: 4096, Commit: uint32(len(data) / 4096), MinTXID: ltx.TXID(min), MaxTXID: ltx.TXID(max), PreApplyChecksum: pre}))
	for start := 0; start < len(data); start += 4096 {
		page := data[start : start+4096]
		if min == 1 || start >= len(base) || !bytes.Equal(page, base[start:start+4096]) {
			check(encoder.EncodePage(ltx.PageHeader{Pgno: uint32(start/4096 + 1)}, page))
		}
	}
	encoder.SetPostApplyChecksum(sum(data))
	check(encoder.Close())
}

func legacy(dir string, data []byte) {
	out := new(bytes.Buffer)
	hash := crc64.New(crc64.MakeTable(crc64.ISO))
	header := ltx.Header{Version: ltx.Version, PageSize: 4096, Commit: uint32(len(data) / 4096), MinTXID: 1, MaxTXID: 1}
	b, err := header.MarshalBinary()
	check(err)
	out.Write(b)
	hash.Write(b)
	index := new(bytes.Buffer)
	for start := 0; start < len(data); start += 4096 {
		pgno := uint32(start/4096 + 1)
		offset := out.Len()
		b, err := (&ltx.PageHeader{Pgno: pgno}).MarshalBinary()
		check(err)
		out.Write(b)
		hash.Write(b)
		page := data[start : start+4096]
		writer := lz4.NewWriter(out)
		_, err = writer.Write(page)
		check(err)
		check(writer.Close())
		hash.Write(page)
		index.Write(binary.AppendUvarint(nil, uint64(pgno)))
		index.Write(binary.AppendUvarint(nil, uint64(offset)))
		index.Write(binary.AppendUvarint(nil, uint64(out.Len()-offset)))
	}
	zero := make([]byte, 6)
	out.Write(zero)
	hash.Write(zero)
	index.WriteByte(0)
	binary.Write(index, binary.BigEndian, uint64(index.Len()))
	out.Write(index.Bytes())
	hash.Write(index.Bytes())
	post := binary.BigEndian.AppendUint64(nil, uint64(sum(data)))
	out.Write(post)
	hash.Write(post)
	out.Write(binary.BigEndian.AppendUint64(nil, uint64(ltx.ChecksumFlag)|hash.Sum64()))
	check(os.WriteFile(filepath.Join(dir, "legacy-frame.ltx"), out.Bytes(), 0644))
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "verify" {
		data, err := os.ReadFile(os.Args[2])
		check(err)
		check(ltx.NewDecoder(bytes.NewReader(data)).Verify())
		return
	}
	dir := os.Args[1]
	base := read(dir, "base.sqlite")
	grown := read(dir, "grown.sqlite")
	shrunk := read(dir, "shrunk.sqlite")
	encode(dir, "snapshot.ltx", nil, base, 1, 1)
	encode(dir, "delta.ltx", base, grown, 2, 2)
	encode(dir, "shrink.ltx", grown, shrunk, 3, 3)
	encode(dir, "overlap.ltx", base, shrunk, 2, 3)
	encode(dir, "high-txid.ltx", base, grown, 9007199254740994, 9007199254740994)
	legacy(dir, base)
}
