# LICENSE
CC BY-NC 4.0

# Associated Python Library
BattGP [https://github.com/JoachimSchaeffer/BattGP](https://github.com/JoachimSchaeffer/BattGP)
This library contains classes and functions to analyze the data set with Gaussian processes. 
Furthermore, data visualization functions are part of the library.

# Technical Specifications
Nominal voltage: 24 V         
Nominal capacity approx. 160 Ah
Current sensor 1
Voltage sensors 9
Temperature sensors 4
Cell balancing current sensors 8
Cathode chemistry: LFP

# Data Set Details
Number of systems: 28
Total number of cells: 232
Total rows of data: 133 million

# Notes 
The data set contains data from 28 portable 24V lithium iron phosphate (LFP) battery systems with approximately 160Ah nominal capacity. Each system's specific use case is unknown, but battery systems of this size are typically used as power sources for recreational vehicles, solar energy storage, and more. 

All battery systems in this data set showed some form of unsatisfactory behavior and were returned to the manufacturer. Many reasons can cause a consumer to return a battery to the manufacturer for maintenance. The user's individual decisions may be motivated by personal judgment, BMS warnings, or customer support advice. This data set comprises a very small fraction of batteries sold of this version. Therefore, this data set is biased and not representative of the operational data of the entire population of this system version. An improved version replaced this battery system type. The battery system manufacturer provided the data set for this study and allowed its open-source release under the condition of anonymity.

Each battery system consists of 8 prismatic cells in series. Each system has one load current sensor, and each cell has one voltage sensor. The four temperature sensors are placed between adjacent cells, i.e., each temperature sensor is shared by two cells. Furthermore, the battery systems have active cell balancing. The available measurements vary from a single month to five years. Consequently, the number of data rows per system varies from several thousand to millions, depending on the duration of battery operation. The data set contains a total of 133 million rows of measurements. 