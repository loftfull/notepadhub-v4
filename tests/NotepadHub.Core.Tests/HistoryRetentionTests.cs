using NotepadHub.Core;

namespace NotepadHub.Core.Tests;

/// <summary>
/// Tiered retention of NoteStore.HistoryFilesToDelete: the newest 50 snapshots always survive (the old
/// behavior), and older ones are thinned to one per day / week / month instead of being deleted outright,
/// bounded by 200 files and 16 MB.
/// </summary>
public class HistoryRetentionTests
{
    private static readonly DateTime Now = new(2026, 10, 16, 12, 0, 0, DateTimeKind.Utc);

    private static NoteStore.HistoryFileInfo F(string name, DateTime stampUtc, long bytes = 100) =>
        new("/history/" + name, bytes, stampUtc);

    /** 50 fresh snapshots within the last hour: the always-kept working set. */
    private static List<NoteStore.HistoryFileInfo> FreshBaseline() =>
        Enumerable.Range(0, 50).Select(i => F($"fresh-{i:D3}.txt", Now.AddMinutes(-i))).ToList();

    private static List<string> Kept(IReadOnlyList<NoteStore.HistoryFileInfo> newestFirst)
    {
        var delete = NoteStore.HistoryFilesToDelete(newestFirst, Now).ToHashSet();
        return newestFirst.Where(f => !delete.Contains(f.FullName)).Select(f => f.FullName).ToList();
    }

    [Fact]
    public void Fewer_than_50_snapshots_are_never_deleted()
    {
        var files = Enumerable.Range(0, 10).Select(i => F($"a-{i}.txt", Now.AddDays(-400).AddHours(-i))).ToList();
        Assert.Empty(NoteStore.HistoryFilesToDelete(files, Now));
    }

    [Fact]
    public void A_fresh_burst_keeps_exactly_the_newest_50_like_the_old_rule()
    {
        // 60 snapshots within the last hour: past the 50th the daily tier has nothing new to offer (same day)
        var files = Enumerable.Range(0, 60).Select(i => F($"b-{i:D3}.txt", Now.AddMinutes(-i))).ToList();
        var kept = Kept(files);
        Assert.Equal(50, kept.Count);
        Assert.Equal(files.Take(50).Select(f => f.FullName), kept);
    }

    [Fact]
    public void Older_snapshots_are_thinned_to_one_per_day_not_dropped()
    {
        var files = FreshBaseline();
        // three snapshots on day -2, one on day -3: the extra same-day copies go, the daily milestones stay
        files.Add(F("d2-a.txt", Now.AddDays(-2).AddHours(-3)));
        files.Add(F("d2-b.txt", Now.AddDays(-2).AddHours(-5)));
        files.Add(F("d2-c.txt", Now.AddDays(-2).AddHours(-9)));
        files.Add(F("d3-a.txt", Now.AddDays(-3).AddHours(-1)));
        var kept = Kept(files);
        Assert.Contains("/history/d2-a.txt", kept);
        Assert.Contains("/history/d3-a.txt", kept);
        Assert.DoesNotContain("/history/d2-b.txt", kept);
        Assert.DoesNotContain("/history/d2-c.txt", kept);
    }

    [Fact]
    public void Between_30_and_365_days_one_snapshot_per_week_survives()
    {
        var files = FreshBaseline();
        files.Add(F("w1.txt", Now.AddDays(-40)));
        files.Add(F("w1-same-week.txt", Now.AddDays(-41)));   // -40 and -41: check the week bucket
        files.Add(F("w2.txt", Now.AddDays(-60)));
        var delete = NoteStore.HistoryFilesToDelete(files, Now).ToHashSet();
        Assert.DoesNotContain("/history/w1.txt", delete);
        Assert.DoesNotContain("/history/w2.txt", delete);
        // -41 lands in the same Monday..Sunday week as -40 or the next one; either way at most one of the pair is extra
        var sameWeek = WeekOf(Now.AddDays(-40)) == WeekOf(Now.AddDays(-41));
        Assert.Equal(sameWeek, delete.Contains("/history/w1-same-week.txt"));
    }

    [Fact]
    public void Beyond_a_year_one_snapshot_per_month_survives()
    {
        var files = FreshBaseline();
        files.Add(F("m1.txt", Now.AddDays(-400)));
        files.Add(F("m1-b.txt", Now.AddDays(-405)));   // same calendar month as -400 or not: checked below
        files.Add(F("m2.txt", Now.AddDays(-500)));
        var delete = NoteStore.HistoryFilesToDelete(files, Now).ToHashSet();
        Assert.DoesNotContain("/history/m1.txt", delete);
        Assert.DoesNotContain("/history/m2.txt", delete);
        // -405 either shares the calendar month with -400 (then it is the extra copy and goes) or not (then both stay)
        var sameMonth = MonthOf(Now.AddDays(-400)) == MonthOf(Now.AddDays(-405));
        Assert.Equal(sameMonth, delete.Contains("/history/m1-b.txt"));
    }

    [Fact]
    public void The_byte_budget_applies_past_the_baseline()
    {
        var files = FreshBaseline();   // 50 × 100 B ≈ 5 KB — far under the budget
        // 20 one-megabyte snapshots on 20 distinct days: only enough of them to reach 16 MB is kept
        for (var i = 0; i < 20; i++) files.Add(F($"big-{i:D2}.txt", Now.AddDays(-(2 + i)), bytes: 1024 * 1024));
        var kept = Kept(files);
        Assert.Equal(50 + 15, kept.Count);   // 15 × 1 MB fits under 16 MB after the ~5 KB baseline; the 16th would exceed it
        Assert.Contains("/history/big-00.txt", kept);
        Assert.DoesNotContain("/history/big-19.txt", kept);
    }

    [Fact]
    public void The_total_cap_keeps_at_most_200_snapshots()
    {
        var files = FreshBaseline();
        for (var i = 0; i < 30; i++) files.Add(F($"day-{i:D2}.txt", Now.AddDays(-(2 + i) * 0.4)));   // daily tier filler
        for (var w = 0; w < 52; w++) files.Add(F($"week-{w:D2}.txt", Now.AddDays(-(35 + w * 7))));   // weekly tier
        for (var m = 0; m < 120; m++) files.Add(F($"month-{m:D3}.txt", Now.AddDays(-(400 + m * 31)))); // monthly tier
        var kept = Kept(files.OrderBy(f => f.LastWriteTimeUtc).Reverse().ToList());
        Assert.Equal(NoteStore.HistoryMaxTotal, kept.Count);
    }

    private static DateTime WeekOf(DateTime d) => d.Date.AddDays(-(((int)d.DayOfWeek + 6) % 7));
    private static DateTime MonthOf(DateTime d) => new(d.Year, d.Month, 1);
}
