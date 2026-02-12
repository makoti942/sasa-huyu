// Improved reset dialog implementation
function showResetDialog() {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<h2>Reset</h2><p>Are you sure you want to reset?</p>'; 

    const confirmButton = document.createElement('button');
    confirmButton.textContent = 'Confirm';
    confirmButton.onclick = () => {
        try {
            // Add logic for reset
            resetData();
            dialog.remove();
        } catch (error) {
            handleError(error);
        }
    };

    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    cancelButton.onclick = () => dialog.remove();

    dialog.appendChild(confirmButton);
    dialog.appendChild(cancelButton);
    document.body.appendChild(dialog);
}

// Enhanced error-handling logic
function handleError(error) {
    console.error('An error occurred:', error);
    alert('Something went wrong: ' + error.message);
}