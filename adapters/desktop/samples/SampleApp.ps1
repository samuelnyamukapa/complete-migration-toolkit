# A tiny Windows Forms app for the desktop adapter's Windows test. -Planted changes one total, as a defect would.
param([switch]$Planted)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Orders'
$qty = New-Object System.Windows.Forms.TextBox
$qty.Name = 'qty'; $qty.Text = '1'; $qty.Top = 10; $qty.Left = 10
$total = New-Object System.Windows.Forms.TextBox
$total.Name = 'total'; $total.ReadOnly = $true; $total.Top = 40; $total.Left = 10
$place = New-Object System.Windows.Forms.Button
$place.Name = 'place'; $place.Text = 'Place order'; $place.Top = 70; $place.Left = 10; $place.Width = 120
$place.Add_Click({
    $price = 10
    if ($Planted) { $price = 10.5 }
    $total.Text = ([int]$qty.Text * $price).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
    $form.Text = 'Order placed'
})
$form.Controls.AddRange(@($qty, $total, $place))
[void]$form.ShowDialog()
