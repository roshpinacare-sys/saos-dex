#!/bin/bash

# סקריפט הטמעת cgroups עבור SAOS-DEX
# מטרה: בידוד תהליך ה-dex עם מגבלות משאבים

set -e

# פונקציות עזר
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

error_exit() {
    log "שגיאה: $1"
    exit 1
}

# בדיקת הרשאות root
if [ "$EUID" -ne 0 ]; then
    error_exit "נדרשות הרשאות root כדי להגדיר cgroups"
fi

# ניקוי קבצי cgroups קיימים (אם קיימים)
cleanup_cgroups() {
    log "מנקה cgroups קיימים..."
    if mountpoint -q /sys/fs/cgroup/dex; then
        umount /sys/fs/cgroup/dex || true
        rmdir /sys/fs/cgroup/dex || true
    fi
    
    # מחיקת cgroup קיים
    if [ -d /sys/fs/cgroup/dex ]; then
        rmdir /sys/fs/cgroup/dex || true
    fi
}

# יצירת מבנה cgroups
setup_cgroups() {
    log "יוצר מבנה cgroups עבור dex..."
    
    # יצירת cgroup ראשי
    mkdir -p /sys/fs/cgroup/dex || error_exit "לא ניתן ליצור cgroup ראשי"
    
    # יצירת תתי-cgroups למשימות שונות
    mkdir -p /sys/fs/cgroup/dex/api
    mkdir -p /sys/fs/cgroup/dex/chain"
    mkdir -p /sys/fs/cgroup/dex/relay"
    mkdir -p /sys/fs/cgroup/dex/ui"
    
    # הגדרת מנהל זיכרון
    mount -t cgroup -o memory memory /sys/fs/cgroup/dex || log "אזהרה: לא ניתן למ�ount cgroup memory"
    
    # הגדרת מנהל CPU
    mount -t cgroup -o cpu,cpuacct cpu /sys/fs/cgroup/dex || log "אזהרה: לא ניתן ל-mount cgroup cpu"
}

# הגדרת מגבלות משאבים
set_limits() {
    log "מגדיר מגבלות משאבים..."
    
    # מגבלות כלליות ל-cgroup הראשי
    echo "512M" > /sys/fs/cgroup/dex/memory.limit_in_bytes || error_exit "לא ניתן להגדיר מגבלת זיכרון"
    echo "50%" > /sys/fs/cgroup/dex/cpu.cfs_quota_us || error_exit "לא ניתן להגדיר מגבלת CPU"
    
    # מגבלות ספציפיות לתתי-cgroups
    # API - פחות משאבים כי צריך להיות זמין תמיד
    echo "256M" > /sys/fs/cgroup/dex/api/memory.limit_in_bytes
    echo "30%" > /sys/fs/cgroup/dex/api/cpu.cfs_quota_us
    
    # CHAIN - יותר משאבים כי הוא עובד עם הבלוקציין
    echo "1024M" > /sys/fs/cgroup/dex/chain/memory.limit_in_bytes
    echo "60%" > /sys/fs/cgroup/dex/chain/cpu.cfs_quota_us
    
    # RELAY - מתאים לשידורים
    echo "512M" > /sys/fs/cgroup/dex/relay/memory.limit_in_bytes
    echo "40%" > /sys/fs/cgroup/dex/relay/cpu.cfs_quota_us
    
    # UI - מינימום משאבים
    echo "128M" > /sys/fs/cgroup/dex/ui/memory.limit_in_bytes
    echo "20%" > /sys/fs/cgroup/dex/ui/cpu.cfs_quota_us
    
    # הגדרת I/O דיסק
    echo "100" > /sys/fs/cgroup/dex/blkio.weight || log "אזהרה: blkio לא זמין"
}

# יצירת סקריפט הפעלה ל-dex
create_launch_script() {
    log "יוצר סקריפט הפעלה מוגן עבור dex..."
    
    cat > /usr/local/bin/run-dex.sh << 'EOF'
#!/bin/bash

# הפעלת SAOS-DEX תחת cgroups
export DATABASE_URL=file:/home/z/my-project/repos/saos-dex/db/dex.db
export SAOS_DEX_STATE_DIR=/home/z/my-project/repos/saos-dex/db

# הגדרת תהליך ב-cgroups מתאימים
setup_cgroup_process() {
    local pid="$1"
    local process_type="$2"
    
    # הגדרת PID ב-cgroup המתאים
    echo "$pid" > /sys/fs/cgroup/dex/tasks
    echo "$pid" > /sys/fs/cgroup/dex/$process_type/tasks
}

# הפעלת Next.js עם תהליכים מבודדים
start_dex() {
    # הפעלת תהליך ה-API
    cd /home/z/my-project/repos/saos-dex
    npm run dev > /var/log/dex-api.log 2>&1 &
    api_pid=$!
    setup_cgroup_process "$api_pid" "api"
    
    # הפעלת תהליך ה-chain
    node src/lib/dex/chain.js > /var/log/dex-chain.log 2>&1 &
    chain_pid=$!
    setup_cgroup_process "$chain_pid" "chain"
    
    # הפעלת תהליך ה-relay
    node src/lib/dex/relay.js > /var/log/dex-relay.log 2>&1 &
    relay_pid=$!
    setup_cgroup_process "$relay_pid" "relay"
    
    # הפעלת ה-UI (אם נדרש)
    # npm run start > /var/log/dex-ui.log 2>&1 &
    # ui_pid=$!
    # setup_cgroup_process "$ui_pid" "ui"
    
    echo "SAOS-DEX הופעל עם PID: $api_pid, $chain_pid, $relay_pid"
}

# פונקציית ניקוי ביציאה
cleanup() {
    echo "מנקה תהליכים ו-cgroups..."
    # כאן ניתן להוסיף לוגיקה לסגירת תהליכים
    exit 0
}

trap cleanup EXIT

start_dex

# שמירה על תהליך ראשי
waitEOF
    
    chmod +x /usr/local/bin/run-dex.sh
}

# הגדרת systemd service
create_systemd_service() {
    log "יוצר service systemd עבור dex..."
    
    cat > /etc/systemd/system/saos-dex.service << 'EOF'
[Unit]
Description=SAOS-DEX Decentralized Exchange
After=network.target

[Service]
Type=simple
User=dexuser
Group=dexuser
ExecStart=/usr/local/bin/run-dex.sh
Restart=always
RestartSec=10
Environment=DATABASE_URL=file:/home/z/my-project/repos/saos-dex/db/dex.db
Environment=SAOS_DEX_STATE_DIR=/home/z/my-project/repos/saos-dex/db

# הגבלות משאבים ברמת systemd (גיבוי ל-cgroups)
LimitMEMLOCK=infinity
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
    
    # יצירת משתמש נפרד להפעלת ה-dex
    if ! id "dexuser" &>/dev/null; then
        useradd -r -s /bin/false dexuser || log "אזהרה: לא ניתן ליצור משתמש dexuser"
    fi
    
    # הפעלת ה-service
    systemctl daemon-reload
    systemctl enable saos-dex.service
}

# פונקציית וריפיקציה
verify_setup() {
    log "בודק הגדרות cgroups..."
    
    # בדיקה אם cgroups קיימים
    if [ ! -d /sys/fs/cgroup/dex ]; then
        error_exit "cgroup לא נוצר בהצלחה"
    fi
    
    # בדיקת מגבלות זיכרון
    mem_limit=$(cat /sys/fs/cgroup/dex/memory.limit_in_bytes)
    if [ "$mem_limit" -lt "536870912" ]; then  # 512MB
        error_exit "מגבלת זיכרון לא נכונה: $mem_limit"
    fi
    
    # בדיקת מגבלות CPU
    cpu_limit=$(cat /sys/fs/cgroup/dex/cpu.cfs_quota_us)
    if [ "$cpu_limit" -lt "50000" ]; then  # 50%
        error_exit "מגבלת CPU לא נכונה: $cpu_limit"
    fi
    
    log "אימות הצליח: cgroups מוגדרים כראוי"
}

# זרימת ההפעלה
main() {
    log "מתחיל הטמעת cgroups עבור SAOS-DEX..."
    
    cleanup_cgroups
    setup_cgroups
    set_limits
    create_launch_script
    create_systemd_service
    verify_setup
    
    log "הטמעת cgroups הושלמה בהצלחה!"
    log "כדי להפעיל את ה-dex: systemctl start saos-dex"
    log "כדי לבדוק מצב: systemctl status saos-dex"
}

main "$@"
