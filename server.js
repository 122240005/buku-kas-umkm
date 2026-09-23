require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Fungsi pembersih nominal uang dari format teks/koma agar tidak pernah NaN
function cleanNumber(val) {
    if (!val) return 0;
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    const cleaned = String(val).replace(/[^0-9.-]+/g, '');
    return parseFloat(cleaned) || 0;
}

// 1. ENDPOINT LOGIN (Username & Password Sederhana)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    // Password default (Ganti sesuai keinginan)
    const ADMIN_USER = process.env.ADMIN_USER || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASS || "123456";

    if (username === ADMIN_USER && password === ADMIN_PASS) {
        return res.json({ success: true, token: "session_active_token_123" });
    }
    return res.status(401).json({ success: false, message: "Username atau Password salah!" });
});

// 2. FETCH MASTER AKUN
app.get('/api/accounts', async (req, res) => {
    try {
        const { data, error } = await supabase.from('accounts').select('*').order('code', { ascending: true });
        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. ENDPOINT AI AKUNTANSI (SAFE PARSING NUMBER)
app.post('/api/ai-journal', async (req, res) => {
    try {
        const { prompt_text } = req.body;
        if (!prompt_text) return res.status(400).json({ success: false, message: 'Kalimat transaksi tidak boleh kosong.' });

        const { data: accounts } = await supabase.from('accounts').select('id, code, name, category');

        // Minta daftar model dari Groq
        const modelsList = await groq.models.list();
        const availableModels = modelsList.data
            .filter(m => m.active !== false)
            .map(m => m.id)
            .filter(id => !id.includes('whisper') && !id.includes('guard') && !id.includes('/') && !id.includes('vision'));

        if (availableModels.length === 0) {
            return res.status(500).json({ success: false, message: "Tidak ada model AI aktif di Groq." });
        }

        const systemInstruction = `
            Kamu adalah Pakar Akuntansi UMKM Indonesia berbasis SAK EMKM.
            Tugas: Menerjemahkan kalimat transaksi sehari-hari menjadi Jurnal Berpasangan (Double-Entry).

            DAFTAR AKUN TERSEDIA DI DATABASE:
            ${JSON.stringify(accounts)}

            ATURAN ANALISIS AKUN PINTAR & LOGIKA AKUNTANSI:
            1. PENGELUARAN PRIBADI PEMILIK (Prive Pemilik - 3-3002) [DEBIT]:
               - Keperluan/konsumsi pribadi: rokok, makan pribadi, belanja rumah, sekolah anak, dll.
            2. PERSEDIAAN / BAHAN DAGANGAN (Persediaan Barang - 1-1301) [DEBIT]:
               - Terigu, beras, bahan baku, kemasan, plastik, box, minyak, dll.
            3. OPERASIONAL TOKO/USAHA (Beban Sewa & Operasional - 5-5003) [DEBIT]:
               - Listrik toko, air toko, sewa ruko, wifi toko, bensin kurir toko.
            4. PENDAPATAN / OMSET (Pendapatan Penjualan - 4-4001) [KREDIT]:
               - Penjualan barang, laku, orderan masuk.
            5. METODE PEMBAYARAN:
               - "transfer", "BCA", "QRIS", "bank", "gopay" -> Gunakan "Bank" (1-1002).
               - "tunai", "cash" ATAU TANPA KETERANGAN -> Gunakan "Kas" (1-1001).

            FORMAT WAJIB JSON MURNI DENGAN ANGKA POLOS (BUKAN STRING):
            {
                "description": "Ringkasan transaksi singkat",
                "human_message": "Pesan ramah menjelaskan pencatatan transaksi",
                "items": [
                    { "account_id": <ID_AKUN_DEBIT>, "debit": <NOMINAL_ANGKA>, "credit": 0 },
                    { "account_id": <ID_AKUN_KREDIT>, "debit": 0, "credit": <NOMINAL_ANGKA> }
                ]
            }
        `;

        let responseText = null;
        let selectedModel = "";

        for (const modelName of availableModels) {
            try {
                const chatCompletion = await groq.chat.completions.create({
                    messages: [
                        { role: "system", content: systemInstruction },
                        { role: "user", content: `Kalimat Transaksi: "${prompt_text}"` }
                    ],
                    model: modelName,
                    response_format: { type: "json_object" }
                });

                responseText = chatCompletion.choices[0]?.message?.content;
                if (responseText) {
                    selectedModel = modelName;
                    break;
                }
            } catch (err) {
                console.log(`[Groq] Model ${modelName} dilewati`);
            }
        }

        if (!responseText) throw new Error("Gagal memproses AI Groq.");

        const journalData = JSON.parse(responseText);

        // Sanitasikan semua item debit & credit agar murni angka
        journalData.items = journalData.items.map(item => ({
            account_id: item.account_id,
            debit: cleanNumber(item.debit),
            credit: cleanNumber(item.credit)
        }));

        res.json({ success: true, data: journalData });

    } catch (err) {
        console.error("Error AI Groq:", err);
        res.status(500).json({ success: false, message: "Gagal memproses transaksi: " + err.message });
    }
});

// 4. SIMPAN TRANSAKSI JURNAL (DENGAN SANITASI ANGKA)
app.post('/api/journals', async (req, res) => {
    try {
        const { transaction_date, description, reference_number, items } = req.body;

        let totalDebit = 0;
        let totalCredit = 0;

        const sanitizedItems = items.map(item => {
            const deb = cleanNumber(item.debit);
            const cred = cleanNumber(item.credit);
            totalDebit += deb;
            totalCredit += cred;
            return {
                account_id: item.account_id,
                debit: deb,
                credit: cred
            };
        });

        if (totalDebit !== totalCredit || totalDebit === 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Jurnal tidak seimbang! Total Debet (Rp ${totalDebit.toLocaleString()}) != Kredit (Rp ${totalCredit.toLocaleString()})` 
            });
        }

        const { data: journalData, error: journalError } = await supabase
            .from('journal_entries')
            .insert([{ transaction_date, description, reference_number }])
            .select().single();

        if (journalError) throw journalError;

        const journalItemsToInsert = sanitizedItems.map(item => ({
            journal_entry_id: journalData.id,
            account_id: item.account_id,
            debit: item.debit,
            credit: item.credit
        }));

        await supabase.from('journal_items').insert(journalItemsToInsert);

        res.status(201).json({ success: true, message: 'Transaksi berhasil disimpan!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));