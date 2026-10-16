namespace NotepadHub.Core.Tests;

/// <summary>
/// Write-through must keep the file's own line endings for the lines the user did not touch (QA2 defect N-06).
/// These are pure-function tests, so they run on every platform; the end-to-end write-through test (QA2 Q2_03) needs Windows.
/// </summary>
public class LineEndingsTests
{
    [Fact]
    public void Mixed_endings_survive_for_untouched_lines()
    {
        // the QA2 Q2_03 scenario: the file is "a<CRLF>b<LF>c", the editor mirror is all-LF, the user changed only the last line
        Assert.Equal("a\r\nb\nc!", NoteStore.MergeLineEndings("a\r\nb\nc", "a\nb\nc!"));
    }

    [Fact]
    public void A_pure_crlf_file_comes_back_all_crlf_like_before()
    {
        Assert.Equal("a\r\nb\r\nc!", NoteStore.MergeLineEndings("a\r\nb\r\nc", "a\nb\nc!"));
        Assert.Equal("a\r\nX\r\nc", NoteStore.MergeLineEndings("a\r\nb\r\nc", "a\nX\nc"));
    }

    [Fact]
    public void Added_lines_get_the_dominant_ending_of_the_file()
    {
        Assert.Equal("a\r\nb\r\nc\r\nd", NoteStore.MergeLineEndings("a\r\nb\r\nc", "a\nb\nc\nd"));
        // a mostly-LF file with one stray CRLF: new lines get LF (the dominant ending)
        Assert.Equal("a\r\nb\nc\nd\ne\nf", NoteStore.MergeLineEndings("a\r\nb\nc\nd\ne", "a\nb\nc\nd\ne\nf"));
    }

    [Fact]
    public void A_file_without_crlf_and_content_with_cr_are_returned_unchanged()
    {
        Assert.Equal("a\nb!", NoteStore.MergeLineEndings("a\nb", "a\nb!"));     // an LF file stays LF
        Assert.Equal("a!", NoteStore.MergeLineEndings("a", "a!"));               // no endings at all: nothing to merge
        Assert.Equal("a\nb", NoteStore.MergeLineEndings("a", "a\nb"));           // the original had no CRLF: content is written as it came
        Assert.Equal("a\r\nb!", NoteStore.MergeLineEndings("a\r\nb", "a\r\nb!")); // a caller that already sends CRLF: untouched
    }

    [Fact]
    public void The_mirror_never_gains_a_trailing_newline()
    {
        // the editor mirror has no trailing newline; the old code did not add one either — parity
        Assert.Equal("a", NoteStore.MergeLineEndings("a\r\n", "a"));
        Assert.Equal("a\r\nb", NoteStore.MergeLineEndings("a\r\nb\r\n", "a\nb"));
    }
}
