# PiConnect Backend Server

This directory contains the Express.js and Socket.IO backend for the PiConnect application.

## Setup

1.  **Navigate to this directory:**
    ```bash
    cd backend
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Create Environment File:**
    Create a `.env` file in this `backend` directory. You will need to add your MongoDB connection string and your Pi Network API Key.

    ```env
    MONGO_URI=your_mongodb_connection_string
    PI_API_KEY=your_pi_network_api_key
    ```
    
    You also need to add your Firebase Service Account credentials as a base64 encoded string. See the instructions in the main project `README.md` for generating the `serviceAccountKey.json`, then run this command to encode it:
    
    ```bash
    # On macOS or Linux
    cat path/to/your/serviceAccountKey.json | base64
    
    # On Windows (in PowerShell)
    [Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\your\serviceAccountKey.json"))
    ```
    
    Copy the resulting long string and add it to your `.env` file:
    
    ```env
    FIREBASE_SERVICE_ACCOUNT_BASE64=your_base64_encoded_string
    ```

4.  **Run the server:**
    ```bash
    npm run dev
    ```

The server will start on port 3001 by default.
