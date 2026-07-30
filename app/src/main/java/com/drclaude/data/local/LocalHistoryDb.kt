package com.drclaude.data.local

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.drclaude.data.GlucoseReading
import com.drclaude.data.Trend

/**
 * On-device glucose history — the free/BYOK privacy mode where nothing leaves the phone.
 *
 * A deliberately lightweight SQLite store (no Room / KSP annotation processor, so it cannot break
 * the build) keyed per patient id, so each profile's history stays isolated. The CGM cloud only
 * serves a rolling ~12–24 h window, so this is what keeps the long-term local record that powers
 * the graph and history screen without sending anything to a server.
 */
class LocalHistoryDb(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE readings (patient TEXT NOT NULL, ts INTEGER NOT NULL, " +
                "value INTEGER NOT NULL, trend INTEGER NOT NULL DEFAULT 0, " +
                "PRIMARY KEY(patient, ts))"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { /* v1 only */ }

    /** Upsert readings for a patient (per-minute primary key dedupes). Safe to call often. */
    fun save(patient: String?, readings: List<GlucoseReading>) {
        if (patient.isNullOrBlank() || readings.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (r in readings) {
                if (r.valueMgDl <= 0) continue
                val cv = ContentValues().apply {
                    put("patient", patient)
                    put("ts", r.timestampMs)
                    put("value", r.valueMgDl)
                    put("trend", r.trend.ordinal)
                }
                db.insertWithOnConflict("readings", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } catch (_: Exception) {
        } finally {
            db.endTransaction()
        }
    }

    /** The most recent [limit] readings for a patient, oldest-first (graph order). */
    fun recent(patient: String?, limit: Int = 500): List<GlucoseReading> {
        if (patient.isNullOrBlank()) return emptyList()
        val out = ArrayList<GlucoseReading>()
        try {
            readableDatabase.rawQuery(
                "SELECT ts, value, trend FROM readings WHERE patient=? ORDER BY ts DESC LIMIT ?",
                arrayOf(patient, limit.toString())
            ).use { c ->
                while (c.moveToNext()) {
                    out.add(
                        GlucoseReading(
                            c.getLong(0), c.getInt(1),
                            Trend.values().getOrElse(c.getInt(2)) { Trend.UNKNOWN }
                        )
                    )
                }
            }
        } catch (_: Exception) {
        }
        return out.sortedBy { it.timestampMs }
    }

    /** Wipe the on-device history for one patient (the Profile "clear local data" button). */
    fun clear(patient: String?) {
        if (patient.isNullOrBlank()) return
        try { writableDatabase.delete("readings", "patient=?", arrayOf(patient)) } catch (_: Exception) {}
    }

    /** Wipe ALL on-device history (every profile). */
    fun clearAll() {
        try { writableDatabase.delete("readings", null, null) } catch (_: Exception) {}
    }

    /** Total readings stored on-device for a patient (shown in Profile). */
    fun count(patient: String?): Int {
        if (patient.isNullOrBlank()) return 0
        return try {
            readableDatabase.rawQuery(
                "SELECT COUNT(*) FROM readings WHERE patient=?", arrayOf(patient)
            ).use { if (it.moveToFirst()) it.getInt(0) else 0 }
        } catch (_: Exception) {
            0
        }
    }

    companion object { private const val DB_NAME = "doctor_claude_history.db" }
}
