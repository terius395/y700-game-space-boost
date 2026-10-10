# Y700 Perf Tuner: tài liệu kỹ thuật

Tài liệu cho người bảo trì module: cơ chế ZUI mà module can thiệp, định dạng dữ liệu, vòng đời
của module, thuật toán sinh config, các sự cố đã gặp và cách gỡ lỗi. Hướng dẫn dùng nằm ở
[README](../README.md).

Mọi kết luận dưới đây đã kiểm chứng trên Legion Y700 Gen4 (TB322FC, codename Kirby-PRC,
SM8750P, ZUXOS 1.1.11.073, Android 15) bằng logcat và sysfs.

## 1. ZUI đặt xung cho các chế độ game thế nào

```
Game Assistant sidebar (com.zui.game.service)
  │  XpuKt.openOverclock(mode) ghi gameMode = 0 | 1 | 2
  ▼
content://com.zui.performance.utils.GameModeProvider/contact
  │
  ▼
com.zui.pp (uid 1000, persistent)
  │  GameStateManager.notifyGameModeChanged → PerformancePolicy.doGameAppStateChange
  │  đọc /data/user/0/com.zui.pp/files/{performanceconfig,game_policy}.xml
  │  PerformanceConnectHelper.sendLimitInner dựng JSON các mức nhiệt
  │  PerformanceConnect.notifyPerfStatusInner(11, status, json)  (IPerformanceNotify)
  ▼
com.zui.tassistent (uid 1000, log tag TGAME)
  │  GameConfig.parseGamePolicyByPP → GameEngine chọn mức theo nhiệt độ
  │  QcomPerfLock → BoostFramework.perfLockAcquire
  ▼
QTI perf HAL → cpufreq scaling_min/max_freq, kgsl min/max_pwrlevel
```

| gameMode | Tên trong code ZUI | Tab trong WebUI |
|---|---|---|
| 0 | DefaultMode | Cân bằng (Balance) |
| 1 | PowerSaveMode | Tiết kiệm pin (Battery Saver) |
| 2 | SavageMode | Hiệu năng (Performance) |

Ngoài bảng xung, `com.zui.pp` còn:
- gọi `IPerformance.setScenarioCode(200 | 100 | 300)` để chọn bộ config thermal-engine. Với
  CPU, các bộ config trong game đều có set_point 495°C nên **không giới hạn gì**;
- acquire perflock của `SpecialBoostConfig` (uclamp boost) ở Balance và Beast;
- chỉnh tần số quét màn hình (không liên quan tới module).

### Bản copy trong data và version

`com.zui.pp` đọc bản copy trong `files/`, không đọc thẳng `/system/etc`:
- lúc khởi động, nó copy `/system/etc/*.xml` đè lên bản copy chỉ khi version của bản system
  **lớn hơn** version của bản copy;
- cloud update (`WhatsNewBroadcastReceiver`, gửi từ UDSEngine) chỉ ghi khi version của cloud
  **lớn hơn version của `/system/etc`**.

Vì vậy module ghi bản tuned với version `29yyMMddHHmm`, lớn hơn mọi version của Lenovo
(dạng `2024xxxx`). Version luôn tăng giữa các lần lưu.

## 2. Định dạng dữ liệu

### game_policy.xml

```xml
<App name="和平精英" pkg="com.tencent.tmgp.pubgmhd">
    <Attribute name="ThermalConfig">200 100 300</Attribute>
    <Attribute name="SpecialBoostConfig">NoBoost NoBoost NoBoost</Attribute>
    <Attribute name="LimitConfig">-1000:20_20_20_20_20|4:21_21_21_21_21 -1000:23_… -1000:26_…</Attribute>
</App>
```

- Các giá trị xếp theo thứ tự **Balance, PowerSave, Beast**, cách nhau bằng dấu cách.
- `LimitConfig` của mỗi mode là danh sách mức nhiệt `nhiệt:id_id_id_id_id`, cách nhau bằng `|`.
  Mức đầu tiên (`-1000` = default) là mức mát nhất. `nhiệt` là chỉ số trong `TempLevel`
  (ví dụ 4 → 38°C).
- 5 id ứng với các `Type` trong `performanceconfig.xml` theo đúng thứ tự (bỏ `TempLevel`):
  LittleCore, BigCore, TitanCore, MegaCore, GPU. Trên firmware này 5 id luôn giống nhau.
- `pkg="default"` dùng cho game không có trong danh sách.
- Mỗi id chỉ thuộc đúng một cặp (mode, mức) (531 id, không trùng), nên chỉnh từng mode độc lập được.

### performanceconfig.xml

```xml
<GameLimitConfig>
    <Type name = "BigCore">
        <Freq level = "20">2400000_1555200_2400000</Freq>   <!-- max_min_boost, kHz -->
    </Type>
    <Type name = "GPU">
        <Freq level = "20">5_11_-1</Freq>                   <!-- pwrlevel max_min_boost -->
    </Type>
</GameLimitConfig>
```

- CPU: `max_min_boost` tính bằng kHz. `-1` nghĩa là không giới hạn.
- GPU: chỉ số kgsl pwrlevel (0 là nhanh nhất), không phải MHz.
- `boost`: TAssistent ghim max = min = boost tạm thời trong cảnh game nặng (TGPA).
- Trên TB322FC: BigCore = policy0 (cpu0-5, tối đa 3.53 GHz), MegaCore = policy6 (cpu6-7,
  tối đa 4.32 GHz). LittleCore và TitanCore đều là `-1`.

## 3. Cách module can thiệp

Module **chỉ thay dữ liệu**, không hook code nào:

1. Sinh `performanceconfig.xml` mới từ bản stock (và `game_policy.xml` nếu bật tăng tốc bộ nhớ).
2. Ghi vào bản copy của `com.zui.pp` bằng `cat` (giữ nguyên owner, quyền và nhãn SELinux),
   rồi `chattr +i` để cloud update không ghi đè được. `com.zui.pp` bắt lỗi khi copy thất bại.
3. Đặt thêm một bản ở `system/etc/` của module (overlay). Trên KernelSU/Magisk có mount module,
   overlay chặn cloud update ngay từ gốc. Root kiểu Magica late-load (máy kiểm thử) **không mount**
   `system/` của module, và module **cố ý không tự bind-mount**: mount hiện trong
   `/proc/*/mountinfo` của mọi app kèm đường dẫn `/adb/modules/...`, anti-cheat dễ phát hiện.
4. Restart `com.zui.pp` (persistent nên hệ thống bật lại ngay) và **dừng service của
   TAssistent** (xem mục 7).

## 4. Cấu trúc và vòng đời module

| File | Chạy khi | Việc làm |
|---|---|---|
| `customize.sh` | cài / cập nhật | Kiểm tra stack ZUI, chép stock từ `/system/etc`. Khi cập nhật: giữ nguyên cài đặt cũ (kể cả trạng thái "gốc"). Firmware khác bản build: bỏ overlay, yêu cầu Lưu lại |
| `service.sh` | mỗi lần boot | Chờ boot xong và data mở khóa (FBE), đồng bộ bản copy với file sinh ra, đặt lại cờ immutable |
| `bin/apply.sh` | WebUI bấm Lưu | Ghi overlay + bản copy, đồng bộ sang bản cập nhật đang chờ reboot, restart |
| `bin/restore.sh` | WebUI Khôi phục gốc | Ghi stock vào bản copy, xóa overlay và `tuning.json` |
| `bin/status.sh` | WebUI mở / sau lưu | In trạng thái dạng `key=value` |
| `bin/sync.sh` | WebUI "Áp dụng lại" | Như `service.sh`, chạy tay |
| `uninstall.sh` | gỡ module | Chép stock và script ra `/data/adb/y700_perf_tuner_restore`, chạy nền `finish-uninstall.sh` |
| `bin/finish-uninstall.sh` | sau khi gỡ | Chờ data mở khóa, trả bản copy về stock, tự xóa |
| `common.sh` | được source | Đường dẫn và các hàm dùng chung |

Dữ liệu trong thư mục module (`/data/adb/modules/y700_perf_tuner`):
- `stock/` là config gốc của **chính máy** (chép lúc cài);
- `tuning.json` là cài đặt người dùng;
- `system/etc/*.xml` là file đã sinh;
- `tuner.log` là nhật ký.

Không có `action.sh`: việc áp lại đã tự động lúc boot, nút Action chỉ gây hiểu nhầm.

Khi KernelSU có bản cập nhật đang chờ reboot (`/data/adb/modules_update/...`), boot sẽ thay
thư mục module bằng bản đó. Vì vậy `apply.sh` / `restore.sh` chép cài đặt mới sang bản chờ
(`mirror_to_staged`), nếu không lần Lưu đó sẽ mất sau reboot.

## 5. WebUI

`webroot/index.html` + `app.js` + `perfgen.js`, chạy trong KernelSU manager qua `ksu.exec`.

- **Phần cứng**: đọc `cpufreq/policy*/{related_cpus,scaling_available_frequencies}` và
  `kgsl-3d0/gpu_available_frequencies`. `PerfGen.detectTables` sắp các cụm theo CPU đầu tiên rồi
  gán tên theo quy ước Lenovo: 1 cụm → Big; 2 → Big, Mega; 3 → Little, Big, Mega; 4 → thêm Titan.
  Chỉ hiện các cụm mà config stock có bảng.
- **Preset** là tỉ lệ so với xung tối đa của từng cụm, làm tròn tới mức gần nhất có trong bảng.
  Trên TB322FC ra đúng 3.07 / 3.51 GHz (Mượt hơn), 1.79 / 1.96 GHz + 525 MHz (Tiết kiệm hơn),
  min 2.92 / 3.51 GHz (Hiệu năng · Tối đa).
- **Ghi file lớn**: `ksu.exec` giới hạn độ dài lệnh, nên XML được chia thành từng đoạn base64
  (60 KB) rồi `base64 -d` trên máy.
- **Trạng thái** lấy từ `bin/status.sh`: Đang hoạt động / Mặc định Lenovo / Cần lưu lại
  (bản copy được sinh từ firmware khác) / Chưa áp dụng (hiện nút Áp dụng lại).
- Version và tác giả đọc từ `module.prop`.

Xem trước giao diện trên PC: phục vụ `webroot/` bằng một HTTP server tĩnh, thêm một shim định
nghĩa `window.ksu.exec` trả dữ liệu mẫu (stock XML, output sysfs).

## 6. Thuật toán sinh config (`lib/perfgen.js`)

Với mỗi game, mỗi mode và mỗi Type có cấu hình:

- **Mức mát nhất** nhận đúng giá trị người dùng chọn (CPU snap xuống mức có trong bảng; GPU: MHz
  → pwrlevel nhanh nhất không vượt giá trị chọn).
- **Các mức nóng hơn** (`scaleHotTiers`, mặc định bật, WebUI không cho tắt): nhân theo cùng tỉ lệ
  `mới / gốc` của mức mát (GPU: dịch cùng số level), snap vào bảng, và **không vượt mức mát**.
  Nếu Lenovo để max `-1` (không giới hạn) ở mức nóng thì chặn bằng mức mát; min `-1` giữ nguyên.
- **Khóa xung** (`lock`): mọi mức nóng chép y hệt mức mát, kể cả các Type không chỉnh.
- **Boost**: nếu boost gốc bằng max thì đi theo max mới; còn lại không thấp hơn max khi nâng,
  không cao hơn max khi hạ.
- **min ≤ max** luôn được giữ (GPU: chỉ số min ≥ chỉ số max).
- Giá trị là **tuyệt đối**: "xung tối đa X" là trần X cho mọi game của mode đó. 8/58 game
  (Subway Surfers, PvZ 2, Brawl Stars, Mini World…) được Lenovo để không giới hạn; đặt X sẽ tạo
  trần X cho cả những game này.

**Tăng tốc bộ nhớ** (`beast.memBoost`) thêm vào `PerformanceSpecialList`:
- `Y700BeastBoost`: các opcode MIN trong profile `Full` của Lenovo, gồm DDR gold 2.09 GHz,
  LLCC 1.07 GHz, L3, uclamp 100. Bỏ các opcode MAX để không vô tình giới hạn bus.
- `Y700Release`: uclamp 0, dùng để nhả lock.

Đồng thời sửa `SpecialBoostConfig` trong `game_policy.xml`: Beast → `Y700BeastBoost`, Balance
`NoBoost` → `Y700Release`. Lý do cần `Y700Release`: `com.zui.pp` chỉ nhả perflock cũ khi acquire
lock mới. Riêng nhánh PowerSave **không acquire gì**, nên lock bộ nhớ còn tới khi thoát game hoặc
chuyển Balance; dữ liệu không sửa được chuyện này.

## 7. Sự cố đã gặp (quan trọng)

1. **TAssistent không đăng ký lại.** `GameManager.onServiceConnected` đăng ký callback rồi
   `mNotifyCallbackList.clear()`. Khi `com.zui.pp` restart và kết nối lại, danh sách rỗng, nên
   TAssistent không bao giờ nhận bảng mới và cứ áp bảng cũ cho tới khi service của nó dừng
   (5 phút sau khi thoát game). Module phải reset TAssistent sau mỗi lần restart `com.zui.pp`.
2. **Không được kill TAssistent.** Tiến trình bị kill trong lúc giữ perflock sẽ để lock đó lại
   trong perf HAL **tới khi reboot**. Perf HAL gộp lock theo mức chặt hơn: CPU max lấy giá trị
   lớn hơn, GPU `max_pwrlevel` lấy chỉ số lớn hơn. Kết quả từng gặp: GPU kẹt ở 734 MHz trong mọi
   mode. Đúng cách: `am stopservice -n com.zui.tassistent/.GameService`, `onDestroy` sẽ nhả lock.
3. **Perf HAL tạm ngưng lock khi tắt màn hình.** Đo lúc màn hình tắt sẽ thấy "không có lock",
   kết quả không đáng tin.
4. **Lưu khi có bản cập nhật chờ reboot** làm mất cài đặt (đã sửa bằng `mirror_to_staged`).
5. **`cat x > x` xóa trắng file**: `apply.sh` luôn làm việc trên bản copy tạm; `write_locked`
   từ chối file rỗng hoặc không phải config.
6. Khi gặp file config hỏng, `com.zui.pp` **không crash** mà lùi về `/system/etc`.

Sau khi lưu, nếu đang chơi thì phải thoát hẳn game rồi mở lại: `com.zui.pp` mới khởi động
không biết game đang chạy.

## 8. Gỡ lỗi

```sh
# log debug của com.zui.pp (mất khi reboot); TAssistent luôn log ở tag TGAME/*
adb shell setprop log.tag.zui_pp D
adb shell su -c 'logcat -G 16M'          # buffer mặc định chỉ 256 KB
adb logcat -v time | grep -E 'POLICYCENTER|CONNECTCENTER|TGAME/|QcomPerfLock'

# giới hạn đang áp
C=/sys/devices/system/cpu/cpufreq; G=/sys/class/kgsl/kgsl-3d0
cat $C/policy0/scaling_{min,max}_freq $C/policy6/scaling_{min,max}_freq
cat $G/{min,max,default}_pwrlevel $G/gpuclk
cat /sys/devices/system/cpu/bus_dcvs/DDR/soc:qcom,memlat:ddr:gold/min_freq

# trạng thái module
su -c 'sh /data/adb/modules/y700_perf_tuner/bin/status.sh'
su -c 'cat /data/adb/modules/y700_perf_tuner/tuner.log'
```

Trong log, dòng `TGAME/QcomPerfLock: param : [...]` là danh sách opcode/giá trị TAssistent gửi:
- `0x40800000` / `0x40804000`: min / max cụm Big (MHz);
- `0x40800200` / `0x40804200`: min / max cụm Mega;
- `0x42800000` / `0x42804000`: GPU min / max (pwrlevel).

## 9. Build và test

```sh
npm test         # tests/perfgen.test.js, không cần dependency
npm run build    # dist/y700_perf_tuner-<version>.zip, version lấy từ module/module.prop
npm run gen      # sinh thử config với config/tuning.json, in thay đổi cho PUBG
```

Build chỉ cần Node.js ≥ 18 (tự đóng zip, timestamp cố định). Zip đi kèm `stock/` của Gen4 và một
config đã sinh từ `config/tuning.json`; `stock.md5` cho `customize.sh` biết config đi kèm có khớp
firmware của máy không.

## 10. Hỗ trợ thiết bị khác (ví dụ Y700 Gen5)

Module cài được trên máy ZUI có `com.zui.pp` và `GameLimitConfig`, nhưng mới kiểm chứng trên
TB322FC. Danh sách cần kiểm khi có máy mới:
1. Pull `/system/etc/{performanceconfig,game_policy}.xml`, xem tên các `Type` và số cụm cpufreq.
2. Xác nhận vẫn là `com.zui.pp` → `com.zui.tassistent` (logcat `TGAME/QcomPerfLock` khi đổi mode).
3. Đo `scaling_max_freq` từng policy và `kgsl max/min_pwrlevel` ở 3 mode, so với bảng đã sinh.
4. Kiểm tra cách gán cụm của perflock: opcode BigCore phải tác động lên policy chứa CPU0.
5. Thêm model vào `VERIFIED_MODELS` (`app.js`) và điều kiện trong `customize.sh`.
