using System.IO.Compression;
using System.Text;
using NotepadHub.Core.Backup;

namespace NotepadHub.Core.Tests;

public class AssetTests
{
    private static readonly byte[] Png = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4, 5, 6, 7, 8 };

    [Fact]
    public void Pictures_are_identified_by_their_bytes_stored_once_and_named_by_content()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var a = s.SaveAsset(Png);
        var b = s.SaveAsset((byte[])Png.Clone());
        Assert.Equal(a, b);
        Assert.Matches(@"^[0-9a-f]{32}\.png$", a);
        Assert.Single(Directory.GetFiles(t.Paths.NotesAssets));
        Assert.Equal(Png, File.ReadAllBytes(Path.Combine(t.Paths.NotesAssets, a)));
        Assert.EndsWith(".jpg", s.SaveAsset(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10 }));
        Assert.EndsWith(".gif", s.SaveAsset(Encoding.ASCII.GetBytes("GIF89a-data")));
        Assert.EndsWith(".webp", s.SaveAsset(Encoding.ASCII.GetBytes("RIFF....WEBPVP8 ")));
    }

    [Theory]
    [InlineData("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")]
    [InlineData("MZ this is an exe")]
    [InlineData("<html><script>x</script></html>")]
    public void Anything_that_is_not_a_raster_picture_is_refused(string text)
    {
        using var t = new TempRoot(); using var s = t.Open();
        Assert.Throws<InvalidDataException>(() => s.SaveAsset(Encoding.UTF8.GetBytes(text)));
        Assert.Throws<InvalidDataException>(() => s.SaveAsset(Array.Empty<byte>()));
    }

    [Fact]
    public void A_picture_over_ten_megabytes_is_refused()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var big = new byte[NoteStore.AssetLimitBytes + 1];
        Array.Copy(Png, big, Png.Length);
        Assert.Throws<InvalidDataException>(() => s.SaveAsset(big));
    }

    [Fact]
    public void Backups_carry_the_pictures_and_restore_brings_them_back()
    {
        using var t = new TempRoot(); using var s = t.Open();
        var name = s.SaveAsset(Png);
        var nhub = Path.Combine(t.Path, "pics.nhub");
        NhubBackup.Create(s, nhub, "x");
        File.Delete(Path.Combine(t.Paths.NotesAssets, name));
        NhubBackup.Restore(s, nhub, "x");
        Assert.True(File.Exists(Path.Combine(t.Paths.NotesAssets, name)));
    }

    [Fact]
    public void A_backup_with_a_badly_named_picture_entry_is_rejected()
    {
        using var t = new TempRoot(); using var s = t.Open();
        s.SaveAsset(Png);
        var nhub = Path.Combine(t.Path, "bad.nhub");
        NhubBackup.Create(s, nhub, "x");
        // rename the picture inside the archive to something that is not a content hash
        var forged = Path.Combine(t.Path, "forged.nhub");
        using (var src = ZipFile.OpenRead(nhub))
        using (var dst = ZipFile.Open(forged, ZipArchiveMode.Create))
        {
            foreach (var e in src.Entries)
            {
                var name = e.FullName.StartsWith("notes-assets/") ? "notes-assets/evil.exe" : e.FullName;
                var copy = dst.CreateEntry(name);
                using var i = e.Open(); using var o = copy.Open(); i.CopyTo(o);
            }
        }
        Assert.False(NhubBackup.Inspect(forged).Valid);
    }
}
