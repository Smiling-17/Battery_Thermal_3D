# 🔋 Battery-Thermal-3D: LFP Digital Twin

![3D Battery Digital Twin Demo](assets/demo.gif)

*[Vietnamese version available below / Bản Tiếng Việt ở bên dưới]*

## 📖 Overview
**Battery-Thermal-3D** is a professional-grade **Digital Twin** visualization system for a **24V LFP (Lithium Iron Phosphate) 8s1p Battery Pack**. 

This project bridges the gap between raw field telemetry (1.45+ GB of sensor data spanning multiple years) and interactive 3D electrochemical/thermal analysis. It processes millions of raw data points into a lightweight, physics-informed model rendered entirely in the browser using **WebGL (Three.js)**.

## ✨ Key Features
- **Interactive 3D Visualization**: Inspect individual cells, busbars, balancing channels, and the BMS board in a full 3D spatial environment.
- **Time-Series Playback**: Smoothly replay years of historical battery data down to the minute.
- **Multi-layer Thermal Analysis**:
  - 🌡️ **Measured Temp**: Direct sensor readings mapped to the physical geometry.
  - 🧠 **Estimated Temp**: Physics-informed internal core temperature estimations.
  - 🔥 **Heat Gen**: Visualization of real-time Joule heating and entropic heat generation.
  - ⚠️ **Thermal Risk**: Predictive gradient mapping to identify potential thermal runaway cells.
- **Explode View**: Dynamically separate battery components to inspect internal temperature gradients.

## 📐 System Architecture

`mermaid
graph TD
    A[(Raw Field Data<br/>1.45GB CSV)] -->|Python Pipeline| B(Data Processing<br/>\uild_sys5_digital_twin.py\)
    B -->|Validation| C{Data Validation<br/>\alidate_sys5_digital_twin.py\}
    B -->|Chunking & Aggregation| D[Optimized JSON Chunks<br/>\
aw_daily/*.json\]
    D -->|Fetch API| E(Frontend Engine<br/>\data-loader.js\)
    E -->|Physics State| F(Three.js Renderer<br/>\scene-bindings.js\)
    F --> G[Interactive 3D Web Interface]
    
    style A fill:#2d3436,stroke:#dfe6e9,stroke-width:2px,color:#fff
    style B fill:#0984e3,stroke:#74b9ff,stroke-width:2px,color:#fff
    style D fill:#00b894,stroke:#55efc4,stroke-width:2px,color:#fff
    style G fill:#d63031,stroke:#fab1a0,stroke-width:2px,color:#fff
`

## 📥 Dataset Download
Because the raw field data exceeds GitHub's size limits (**1.45 GB**), the dataset is not included in this repository. 
You can download the full dataset (both the raw CSV and the pre-processed JSON chunks) from Google Drive:

[**📥 Download Battery_Thermal_3D_dataset**](https://drive.google.com/drive/folders/1UREt09zBo2cqDqZAb9PZWRsE_4If0K20?usp=sharing)

*Instructions:* Extract the downloaded folders and merge them into the root directory. 
- \data/data_sys_5.csv\ (Raw Data)
- \simulation_3d/processed/\ (Compiled JSON chunks - skips the build step!)

## 🚀 Quick Start

### Prerequisites
- **Python 3.8+** (for data processing pipeline)
- A modern web browser with WebGL support

`ash
# Clone the repository
git clone https://github.com/Smiling-17/Battery_Thermal_3D.git
cd Battery_Thermal_3D

# Install Python dependencies
pip install -r requirements.txt
`

### 1. Build the Digital Twin Data (Optional if downloaded from Drive)
If you downloaded the raw CSV but not the \processed/\ folder, you must build the JSON chunks:
`ash
python tools/build_sys5_digital_twin.py
`
*(Note: Processing ~10 million rows will take a few minutes).*

### 2. Run the Visualization Server
Since the application fetches local JSON files, it must be served over HTTP:
`ash
cd simulation_3d
python -m http.server 5173
`

### 3. View the Application
Open your browser and navigate to: **http://localhost:5173**

---
---

# 🇻🇳 Bản sao Kỹ thuật số (Digital Twin) Hệ thống Pin

## 📖 Tổng quan
**Battery-Thermal-3D** là một hệ thống **Bản sao Kỹ thuật số (Digital Twin)** chuyên nghiệp dành cho cụm pin **24V LFP (Lithium Iron Phosphate) 8s1p**.

Dự án này là cầu nối giữa dữ liệu cảm biến thô (hơn 1.45 GB dữ liệu lịch sử) và hệ thống phân tích nhiệt/điện hóa 3D trực quan. Hệ thống xử lý hàng triệu điểm dữ liệu thành một mô hình vật lý nhẹ gọn, được render hoàn toàn trên trình duyệt thông qua **WebGL (Three.js)**.

## ✨ Tính năng Cốt lõi
- **Hiển thị 3D Tương tác**: Quan sát chi tiết từng cell pin, thanh cái (busbar), dây cân bằng và mạch BMS trong không gian 3 chiều.
- **Phát lại Dữ liệu Lịch sử (Playback)**: Tua nhanh mượt mà hàng năm trời dữ liệu thực tế tới độ phân giải từng phút.
- **Phân tích Nhiệt lượng Đa lớp**:
  - 🌡️ **Nhiệt độ Đo lường (Measured Temp)**: Dữ liệu thực tế từ cảm biến áp trực tiếp lên mô hình 3D.
  - 🧠 **Nhiệt độ Ước tính (Estimated Temp)**: Thuật toán nội suy mô phỏng nhiệt độ lõi bên trong pin.
  - 🔥 **Sinh Nhiệt (Heat Gen)**: Trực quan hóa lượng nhiệt tỏa ra do hiệu ứng Joule và quá trình điện hóa.
  - ⚠️ **Rủi ro Nhiệt (Thermal Risk)**: Cảnh báo vùng chênh lệch nhiệt độ cao, nguy cơ thoát nhiệt (Thermal runaway).
- **Góc nhìn Phân tách (Explode View)**: Tự động tách rời các khối linh kiện để xem rõ cấu trúc lõi bên trong.

## 📐 Kiến trúc Hệ thống

`mermaid
graph TD
    A[(Dữ liệu thô CSV<br/>1.45GB)] -->|Python Pipeline| B(Xử lý Dữ liệu<br/>\uild_sys5_digital_twin.py\)
    B -->|Kiểm định| C{Validate Dữ liệu<br/>\alidate_sys5_digital_twin.py\}
    B -->|Phân mảnh & Tổng hợp| D[Các gói JSON Tối ưu<br/>\
aw_daily/*.json\]
    D -->|Fetch API| E(Frontend Engine<br/>\data-loader.js\)
    E -->|Trạng thái Vật lý| F(Three.js Renderer<br/>\scene-bindings.js\)
    F --> G[Giao diện Web 3D Tương tác]
    
    style A fill:#2d3436,stroke:#dfe6e9,stroke-width:2px,color:#fff
    style B fill:#0984e3,stroke:#74b9ff,stroke-width:2px,color:#fff
    style D fill:#00b894,stroke:#55efc4,stroke-width:2px,color:#fff
    style G fill:#d63031,stroke:#fab1a0,stroke-width:2px,color:#fff
`

## 📥 Tải Dữ liệu (Dataset)
Vì dữ liệu thô vượt quá giới hạn lưu trữ của GitHub (**1.45 GB**), dataset không được đính kèm trực tiếp trong repository này.
Bạn có thể tải toàn bộ dữ liệu (cả file CSV thô và thư mục JSON đã xử lý sẵn) từ Google Drive:

[**📥 Tải Battery_Thermal_3D_dataset**](https://drive.google.com/drive/folders/1UREt09zBo2cqDqZAb9PZWRsE_4If0K20?usp=sharing)

*Hướng dẫn:* Giải nén và chép đè 2 thư mục tải về vào thư mục gốc của project:
- \data/data_sys_5.csv\ (Dữ liệu gốc)
- \simulation_3d/processed/\ (Dữ liệu JSON đã build sẵn - copy vào để dùng website ngay lập tức!)

## 🚀 Hướng dẫn Cài đặt & Chạy ứng dụng

### Yêu cầu hệ thống
- **Python 3.8+** (nếu bạn muốn tự chạy script xử lý data)
- Trình duyệt Web hiện đại hỗ trợ WebGL

`ash
# Clone repository về máy
git clone https://github.com/Smiling-17/Battery_Thermal_3D.git
cd Battery_Thermal_3D

# Cài đặt thư viện Python
pip install -r requirements.txt
`

### 1. Build Dữ liệu (Bỏ qua bước này nếu đã copy thư mục processed từ Drive)
Nếu bạn chỉ tải file CSV, bạn cần chạy script để build ra các file JSON tĩnh:
`ash
python tools/build_sys5_digital_twin.py
`
*(Lưu ý: Quá trình quét ~10 triệu dòng dữ liệu sẽ mất vài phút).*

### 2. Bật Web Server
Website cần một Local HTTP Server để tải các file JSON:
`ash
cd simulation_3d
python -m http.server 5173
`

### 3. Trải nghiệm
Mở trình duyệt và truy cập: **http://localhost:5173**

---
*Developed as an advanced Digital Twin demonstration for battery management systems.*
